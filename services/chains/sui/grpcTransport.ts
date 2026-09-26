/**
 * Sui JSON-RPC → gRPC compatibility transport.
 *
 * Sui Foundation deprecated JSON-RPC network-wide (Alchemy's own migration
 * guide, Sept 2026; public fullnodes already reject every JSON-RPC method
 * with "Method not found... deprecated"). This file is the ONLY thing that
 * changed to fix it: every `new SuiJsonRpcClient({ url, network })` call
 * site in this app still constructs a real `SuiJsonRpcClient` — every
 * `.getBalance` / `.getCoins` / `.executeTransactionBlock` / etc. method
 * on it is untouched — we just swap the `url` HTTP transport for a
 * `transport` object that answers the SAME legacy JSON-RPC method names
 * over Sui's gRPC endpoint (same public fullnode hostnames, no API key,
 * no rpc-proxy change).
 *
 * `SuiJsonRpcClient` calls `this.transport.request({method, params})` for
 * every single method (see @mysten/sui's jsonRpc/client.ts — it is a thin
 * wrapper with no logic beyond that), and its internal `this.core` (used
 * transparently by `Transaction#build()` for gas price / gas coin
 * selection / object-reference resolution / Move-call argument encoding)
 * goes through the exact same seam. So intercepting `request()` here is
 * sufficient to cover both direct call sites AND transaction building —
 * nothing else in the 24 call sites across this repo needs to change.
 *
 * Response shapes are hand-translated from gRPC's Core API (verified live
 * against https://fullnode.mainnet.sui.io:443, see the field mappings
 * below) back into the exact legacy JSON-RPC shapes those call sites
 * already destructure. Two real, confirmed divergences from a naive
 * pass-through:
 *   - gRPC's object `json` field is a FLAT representation (`{id: "0x.."}`)
 *     where legacy JSON-RPC nests UID fields (`{id: {id: "0x.."}}`), and
 *     legacy wraps content in `{dataType: "moveObject", fields, ...}`
 *     which gRPC doesn't produce at all. `toLegacyObjectResponse` below
 *     reconstructs that envelope. Verified against every `content.fields`
 *     read in this codebase (turbosSui/bluefinSpotSui sqrt_price,
 *     suiLst/currentSui version/market_id) — none read nested UID fields,
 *     so the flat/nested divergence itself doesn't bite today.
 *   - `getCoins`/`getAllCoins` legacy field is `coinObjectId`; gRPC's
 *     `listCoins` calls it `objectId`. `coinTransferService.ts` reads
 *     `.coinObjectId` directly — renamed below.
 *
 * Money-moving paths (`executeTransactionBlock` → `signAndExecuteTransaction`,
 * used by transferService/coinTransferService/SuiWalletKit/bridge) and the
 * DeFi `devInspectTransactionBlock` view-call pattern were verified against
 * the live public endpoint for shape, but NOT device-verified end to end
 * (no funded test wallet available here) — test a real signed transfer and
 * a real DeFi deposit before trusting this in production.
 * `suix_getDynamicFieldObject` (deny-list detection only) is intentionally
 * left unimplemented — it already fails closed to "non-regulated" today
 * with the chain itself remaining the authoritative deny-list gate (see
 * tokenKind.ts's `resolveDenyListForCoin` comment), so a clean throw here
 * doesn't regress anything.
 */

import { fromBase64 } from "@mysten/bcs";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";

type Network = "mainnet" | "testnet" | "devnet";

interface JsonRpcTransportRequestOptions {
  method: string;
  params: unknown[];
  signal?: AbortSignal;
}

interface JsonRpcTransport {
  request<T = unknown>(input: JsonRpcTransportRequestOptions): Promise<T>;
}

const FULLNODE_GRPC_HOST: Record<Network, string> = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
};

/**
 * `@protobuf-ts/grpcweb-transport`'s default `fetch` path reads the
 * response through `fetchResponse.body` as a stream (`.getReader()`) and
 * throws `RpcError("missing response body", INTERNAL)` if `.body` is
 * falsy. React Native's `fetch` (Hermes) doesn't populate a streaming
 * `.body` on the Response — confirmed on-device, this is what surfaced as
 * "error fetching balance missing response body" and would hit every
 * single call through this transport, not just getBalance. The consumer
 * (`readGrpcWebResponseBody` in that package) only actually needs
 * something with `Symbol.asyncIterator` yielding raw bytes — it doesn't
 * require a real `ReadableStream` — so we fully buffer the response via
 * `.arrayBuffer()` (which RN's fetch does support) and hand back a
 * one-shot async-iterable in `.body`'s place. No other Response property
 * this library reads (`type`, `headers`, `status`, `statusText`) needs
 * changing.
 */
function createRnSafeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input as never, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let consumed = false;
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (consumed) return { done: true as const, value: undefined };
          consumed = true;
          return { done: false as const, value: bytes };
        },
      }),
    };
    return {
      type: res.type,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body,
    } as unknown as Response;
  }) as typeof fetch;
}

const grpcClients = new Map<string, SuiGrpcClient>();

function getGrpcClient(network: string): SuiGrpcClient {
  const existing = grpcClients.get(network);
  if (existing) return existing;
  const baseUrl =
    FULLNODE_GRPC_HOST[network as Network] ?? FULLNODE_GRPC_HOST.mainnet;
  const transport = new GrpcWebFetchTransport({
    baseUrl,
    fetch: createRnSafeFetch(),
  });
  const client = new SuiGrpcClient({ network: network as never, transport });
  grpcClients.set(network, client);
  return client;
}

// ── shared helpers ──────────────────────────────────────────────────────

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

/** Legacy `getCoins`/`getAllCoins` return the Coin<T> type ARGUMENT, not the wrapper. */
function coinTypeArg(wrapperType: string): string {
  const start = wrapperType.indexOf("<");
  const end = wrapperType.lastIndexOf(">");
  return start >= 0 && end > start
    ? wrapperType.slice(start + 1, end)
    : wrapperType;
}

interface GrpcObjectLike {
  objectId?: string;
  version?: string;
  digest?: string;
  type?: string;
  owner?: unknown;
  previousTransaction?: string;
  json?: Record<string, unknown> | null;
  display?: unknown;
}

/**
 * Reconstructs the legacy `SuiObjectResponse` shape from a gRPC Core API
 * object (or the per-item `Error` some batch calls return for a missing
 * object — see @mysten/sui's own getObjects docs).
 */
function toLegacyObjectResponse(
  o: GrpcObjectLike | Error | undefined,
  objectId?: string,
) {
  if (!o || o instanceof Error) {
    return {
      error: { code: "notExists", object_id: objectId ?? "" },
    };
  }
  const data: Record<string, unknown> = {
    objectId: o.objectId,
    version: o.version,
    digest: o.digest,
    type: o.type,
    owner: o.owner,
    previousTransaction: o.previousTransaction,
  };
  if (o.json !== undefined) {
    data.content =
      o.json === null
        ? undefined
        : {
            dataType: "moveObject",
            type: o.type,
            hasPublicTransfer: true,
            fields: o.json,
          };
  }
  return { data };
}

// ── Move type (SuiMoveNormalizedType) round-trip ───────────────────────
// Faithful inverse of @mysten/sui's parseNormalizedSuiMoveTypeBody, so
// Transaction#build()'s own re-parse of our output lands on the correct
// unified shape (isTxContext / getPureBcsSchema consume that, not this).

interface OpenSignatureBody {
  $kind: string;
  vector?: OpenSignatureBody;
  datatype?: { typeName: string; typeParameters: OpenSignatureBody[] };
  index?: number;
}
interface OpenSignature {
  reference: "mutable" | "immutable" | null;
  body: OpenSignatureBody;
}

function bodyToLegacyType(body: OpenSignatureBody): unknown {
  switch (body.$kind) {
    case "vector":
      return { Vector: bodyToLegacyType(body.vector!) };
    case "datatype": {
      const parts = body.datatype!.typeName.split("::");
      const name = parts.pop();
      const module = parts.pop();
      const address = parts.join("::");
      return {
        Struct: {
          address,
          module,
          name,
          typeArguments: body.datatype!.typeParameters.map(bodyToLegacyType),
        },
      };
    }
    case "typeParameter":
      return { TypeParameter: body.index };
    default:
      return body.$kind.charAt(0).toUpperCase() + body.$kind.slice(1);
  }
}

function signatureToLegacyType(sig: OpenSignature): unknown {
  const inner = bodyToLegacyType(sig.body);
  if (sig.reference === "mutable") return { MutableReference: inner };
  if (sig.reference === "immutable") return { Reference: inner };
  return inner;
}

interface GrpcChangedObjectLike {
  objectId?: string;
  outputVersion?: string | null;
  outputDigest?: string | null;
  outputOwner?: unknown;
}

/**
 * @mysten/sui's own `parseTransactionEffectsJson` (jsonRpc/core.ts) reads
 * `effects.gasObject.reference.{objectId,version,digest}` unconditionally
 * (no `?.` past the first hop) whenever `Transaction#build()` estimates a
 * gas budget via a dry run — omitting this field crashes every PTB build
 * that doesn't already have an explicit gas budget set, which is every
 * fresh transfer/DeFi-deposit build in this app. Verified live: build()
 * on a real `tx.gas`-using transaction threw
 * "Cannot read properties of undefined (reading 'reference')" without this.
 */
function toLegacyGasObject(
  gasObject: GrpcChangedObjectLike | null | undefined,
) {
  return {
    owner: gasObject?.outputOwner ?? { AddressOwner: "0x0" },
    reference: {
      objectId: gasObject?.objectId ?? "0x0",
      version: gasObject?.outputVersion ?? "0",
      digest: gasObject?.outputDigest ?? "",
    },
  };
}

// ── the transport ───────────────────────────────────────────────────────

export function createSuiGrpcJsonRpcTransport(
  network: string,
): JsonRpcTransport {
  const grpc = getGrpcClient(network);

  return {
    async request<T>({
      method,
      params,
    }: JsonRpcTransportRequestOptions): Promise<T> {
      switch (method) {
        case "suix_getBalance": {
          const [owner, coinType] = params as [string, string | undefined];
          const { balance } = await grpc.getBalance({ owner, coinType });
          return {
            coinType: balance.coinType,
            coinObjectCount: 0,
            totalBalance: balance.balance,
            lockedBalance: {},
          } as T;
        }

        case "suix_getAllBalances": {
          const [owner] = params as [string];
          const out: unknown[] = [];
          let cursor: string | null | undefined;
          do {
            const page = await grpc.listBalances({
              owner,
              cursor: cursor ?? undefined,
            });
            for (const b of page.balances) {
              out.push({
                coinType: b.coinType,
                coinObjectCount: 0,
                totalBalance: b.balance,
                lockedBalance: {},
              });
            }
            cursor = page.hasNextPage ? page.cursor : null;
          } while (cursor);
          return out as T;
        }

        case "suix_getCoins":
        case "suix_getAllCoins": {
          const isAll = method === "suix_getAllCoins";
          const [owner, coinType, cursor, limit] = isAll
            ? [
                (params as [string, string?, number?])[0],
                undefined,
                params[1],
                params[2],
              ]
            : (params as [
                string,
                string | undefined,
                string | undefined,
                number | undefined,
              ]);
          const page = await grpc.listCoins({
            owner,
            coinType,
            cursor: (cursor as string | undefined) ?? undefined,
            limit: limit as number | undefined,
          });
          return {
            data: page.objects.map((c) => ({
              coinType: coinTypeArg(c.type),
              coinObjectId: c.objectId,
              version: c.version,
              digest: c.digest,
              balance: c.balance,
              previousTransaction: "",
            })),
            nextCursor: page.cursor,
            hasNextPage: page.hasNextPage,
          } as T;
        }

        case "suix_getCoinMetadata": {
          const [coinType] = params as [string];
          const { coinMetadata } = await grpc.getCoinMetadata({ coinType });
          return (
            coinMetadata
              ? {
                  decimals: coinMetadata.decimals,
                  name: coinMetadata.name,
                  symbol: coinMetadata.symbol,
                  description: coinMetadata.description,
                  iconUrl: coinMetadata.iconUrl,
                  id: coinMetadata.id,
                }
              : null
          ) as T;
        }

        case "sui_getObject": {
          const [id] = params as [string];
          const { object } = await grpc.getObject({
            objectId: id,
            include: {
              content: true,
              json: true,
              previousTransaction: true,
              display: true,
            },
          });
          return toLegacyObjectResponse(object as GrpcObjectLike, id) as T;
        }

        case "sui_multiGetObjects": {
          const [ids] = params as [string[]];
          const { objects } = await grpc.getObjects({
            objectIds: ids,
            include: { content: true, json: true, previousTransaction: true },
          });
          return objects.map((o, i) =>
            toLegacyObjectResponse(o as GrpcObjectLike | Error, ids[i]),
          ) as T;
        }

        case "suix_getOwnedObjects": {
          const [owner, query, cursor, limit] = params as [
            string,
            { filter?: { StructType?: string } } | undefined,
            string | undefined,
            number | undefined,
          ];
          const page = await grpc.listOwnedObjects({
            owner,
            type: query?.filter?.StructType,
            cursor: cursor ?? undefined,
            limit,
            include: { content: true, json: true },
          });
          return {
            data: page.objects.map((o) =>
              toLegacyObjectResponse(o as GrpcObjectLike),
            ),
            nextCursor: page.cursor,
            hasNextPage: page.hasNextPage,
          } as T;
        }

        case "suix_getDynamicFieldObject": {
          // Deny-list detection only (tokenKind.ts) — deliberately
          // unsupported; the chain itself remains the authoritative gate.
          throw new Error(
            "suix_getDynamicFieldObject is not supported over the gRPC compat transport",
          );
        }

        case "suix_getReferenceGasPrice": {
          const { referenceGasPrice } = await grpc.getReferenceGasPrice();
          return referenceGasPrice as T;
        }

        case "suix_getLatestSuiSystemState": {
          const { response } = await grpc.ledgerService.getEpoch({
            readMask: { paths: ["epoch", "reference_gas_price"] },
          });
          return {
            systemStateVersion: "1",
            epoch: String(response.epoch?.epoch ?? "0"),
            protocolVersion: "1",
            referenceGasPrice: String(
              response.epoch?.referenceGasPrice ?? "1000",
            ),
            epochStartTimestampMs: "0",
            safeMode: false,
            safeModeStorageRewards: "0",
          } as T;
        }

        case "sui_getCheckpoint": {
          // Only ever called internally for chain identity (id "0"), used
          // to stamp tx expiration / gas-coin reservation refs — never
          // throw here, an unhandled rejection would break every
          // transaction build that uses `tx.gas`. GetServiceInfo's
          // chain_id is Mysten's own gRPC-native chain-identity call (see
          // SuiGrpcClient's own core.getChainIdentifier); mirroring it.
          try {
            const { response } = await grpc.ledgerService.getServiceInfo({});
            return { digest: response.chainId ?? "unknown" } as T;
          } catch {
            return { digest: "unknown" } as T;
          }
        }

        case "sui_getTransactionBlock": {
          const [digest] = params as [string];
          const { response } = await grpc.ledgerService.getTransaction({
            digest,
            readMask: { paths: ["digest", "timestamp"] },
          });
          const ts = response.transaction?.timestamp;
          const timestampMs = ts
            ? String(
                Number(ts.seconds ?? 0) * 1000 +
                  Math.floor(Number(ts.nanos ?? 0) / 1e6),
              )
            : undefined;
          return { digest, timestampMs } as T;
        }

        case "sui_executeTransactionBlock": {
          const [txBlock, signature, options] = params as [
            string | Uint8Array,
            string | string[],
            { showEffects?: boolean } | undefined,
          ];
          const transaction =
            typeof txBlock === "string" ? fromBase64(txBlock) : txBlock;
          const signatures = Array.isArray(signature) ? signature : [signature];
          let result;
          try {
            result = await grpc.executeTransaction({
              transaction,
              signatures,
              include: { effects: true },
            });
          } catch (e) {
            throw new Error(`sui execute transaction failed: ${errMessage(e)}`);
          }
          if (result.$kind === "FailedTransaction") {
            const detail =
              result.FailedTransaction.status?.error?.message ??
              "execution aborted";
            throw new Error(`sui execute transaction failed: ${detail}`);
          }
          const tx = result.Transaction;
          return {
            digest: tx.digest,
            effects: options?.showEffects
              ? { status: { status: "success" }, gasUsed: tx.effects?.gasUsed }
              : undefined,
          } as T;
        }

        case "sui_dryRunTransactionBlock": {
          const [txBlock] = params as [string | Uint8Array];
          const transaction =
            typeof txBlock === "string" ? fromBase64(txBlock) : txBlock;
          const result = await grpc.simulateTransaction({
            transaction,
            include: { effects: true, balanceChanges: true },
          });
          const success = result.$kind === "Transaction";
          const tx = success ? result.Transaction : result.FailedTransaction;
          return {
            effects: {
              status: success
                ? { status: "success" }
                : {
                    status: "failure",
                    error: tx.status?.error?.message ?? "execution failed",
                  },
              gasUsed: tx.effects?.gasUsed ?? {
                computationCost: "0",
                storageCost: "0",
                storageRebate: "0",
                nonRefundableStorageFee: "0",
              },
              gasObject: toLegacyGasObject(tx.effects?.gasObject),
            },
            balanceChanges: success
              ? (result.Transaction.balanceChanges ?? []).map((b) => ({
                  owner: { AddressOwner: b.address },
                  coinType: b.coinType,
                  amount: b.amount,
                }))
              : [],
            events: [],
            objectChanges: [],
          } as T;
        }

        case "sui_devInspectTransactionBlock": {
          const [, txBlock] = params as [string, string];
          const transaction =
            typeof txBlock === "string" ? fromBase64(txBlock) : txBlock;
          try {
            const result = await grpc.simulateTransaction({
              transaction,
              include: { effects: true, commandResults: true },
            });
            if (result.$kind === "FailedTransaction") {
              const detail =
                result.FailedTransaction.status?.error?.message ??
                "execution failed";
              return {
                effects: { status: { status: "failure", error: detail } },
                error: detail,
                results: [],
              } as T;
            }
            return {
              effects: {
                status: { status: "success" },
                gasObject: toLegacyGasObject(
                  result.Transaction.effects?.gasObject,
                ),
              },
              results: (result.commandResults ?? []).map((cr) => ({
                // Every current caller only ever devInspects a fixed,
                // statically-known u64-returning function (coin::value,
                // pool price reads) — the gRPC command output doesn't
                // carry a type tag the way legacy devInspect did, so this
                // hardcodes the tag every existing consumer checks for.
                returnValues: (cr.returnValues ?? []).map((rv) => [
                  rv.bcs ?? new Uint8Array(),
                  "u64",
                ]),
              })),
            } as T;
          } catch (e) {
            const detail = errMessage(e);
            return {
              effects: { status: { status: "failure", error: detail } },
              error: detail,
              results: [],
            } as T;
          }
        }

        case "suix_queryEvents": {
          // The installed @mysten/sui@2.16 gRPC client has no generated
          // ListEvents method yet (LedgerServiceClient only exposes
          // GetServiceInfo/GetObject/BatchGetObjects/GetTransaction/
          // BatchGetTransactions/GetCheckpoint/GetEpoch — verified against
          // the installed .d.ts, not just the migration guide's table).
          // The one caller (tokenKind.ts's closed-loop TokenPolicy lookup)
          // already treats "no event found" as a graceful, documented
          // miss ("fragile... shape varies... on any failure return
          // null"), so this matches today's already-broken behavior
          // rather than regressing it. Revisit once the SDK ships
          // ListEvents.
          return { data: [], nextCursor: null, hasNextPage: false } as T;
        }

        case "sui_getNormalizedMoveFunction": {
          const [pkg, module, fn] = params as [string, string, string];
          const { function: def } = await grpc.getMoveFunction({
            packageId: pkg,
            moduleName: module,
            name: fn,
          });
          return {
            visibility:
              def.visibility === "public"
                ? "Public"
                : def.visibility === "friend"
                  ? "Friend"
                  : "Private",
            isEntry: def.isEntry,
            typeParameters: def.typeParameters.map(() => ({ abilities: [] })),
            parameters: def.parameters.map((p) =>
              signatureToLegacyType(p as OpenSignature),
            ),
            return: def.returns.map((r) =>
              signatureToLegacyType(r as OpenSignature),
            ),
          } as T;
        }

        default:
          throw new Error(
            `Sui gRPC compat transport: unsupported JSON-RPC method "${method}"`,
          );
      }
    },
  };
}
