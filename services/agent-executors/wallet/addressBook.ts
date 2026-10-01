/**
 * Address book mobile tool executors.
 *
 * Exposes the user's saved contacts to the AI agent so it can resolve
 * human-friendly labels to blockchain addresses without asking the user
 * to paste an address manually.
 *
 * All three tools require an active session (JWT) because the address
 * book is per-user. The `api` ky instance used by `addressBookApi`
 * attaches the Bearer token from secure storage automatically, so
 * executors here just call the API and return the data.
 *
 * Tools implemented:
 *   - get_address_book        — return all saved contacts
 *   - get_address_book_entry  — return a single contact by id
 *   - search_address_book     — client-side filter by label or address
 */

import { addressBookApi } from "@/api/endpoints/addressBook";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";
import {
  ExecutorError,
  ExecutorErrorCode,
  logExecutorDetail,
  type MobileToolExecutor,
  optionalString,
  requireString,
  safeExecute,
} from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Project an address book entry to the wire shape the agent sees.
 * Only exposes fields that are useful for address resolution — internal
 * server metadata (userId, createdAt, updatedAt) is omitted to keep the
 * context window lean.
 */
function projectEntry(entry: TAddressBookEntry): Record<string, unknown> {
  return {
    id: entry.id,
    label: entry.label,
    address: entry.address,
    ...(entry.ensName ? { ens_name: entry.ensName } : {}),
    ...(entry.notes ? { notes: entry.notes } : {}),
    ...(entry.chainName ? { chain_name: entry.chainName } : {}),
    is_evm: entry.isEvm,
  };
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/**
 * `get_address_book` — return all saved contacts for the connected wallet.
 *
 * Input: none required.
 *
 * Returns: `{ contacts: Contact[] }` where each contact has
 *   id, label, address, ens_name?, notes?, chain_name?, is_evm.
 */
export const getAddressBook: MobileToolExecutor = (_input, _context) =>
  safeExecute(async () => {
    let entries: TAddressBookEntry[];
    try {
      entries = await addressBookApi.getAll();
    } catch (err) {
      logExecutorDetail("address book fetch failed", err);
      throw new ExecutorError(
        ExecutorErrorCode.NetworkError,
        "address_book_unavailable",
      );
    }

    return {
      status: "success",
      data: {
        contacts: entries.map(projectEntry),
        total: entries.length,
      },
    };
  });

/**
 * `get_address_book_entry` — look up a single saved contact by its id.
 *
 * Input: `{ id: string }`
 *
 * Returns: the matching contact or a `failed` result with
 * `not_found` if the id doesn't exist.
 */
export const getAddressBookEntry: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const id = requireString(input, "id");

    let entry: TAddressBookEntry;
    try {
      entry = await addressBookApi.getById(id);
    } catch (err) {
      // Distinguish 404 from network failure so the agent can decide
      // whether to retry or ask the user for a different id.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes("404") ||
        msg.toLowerCase().includes("not found")
      ) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          `contact with id "${id}" not found`,
        );
      }
      logExecutorDetail("contact fetch failed", err);
      throw new ExecutorError(
        ExecutorErrorCode.NetworkError,
        "address_book_unavailable",
      );
    }

    return {
      status: "success",
      data: projectEntry(entry),
    };
  });

/**
 * `search_address_book` — client-side search across the user's contacts.
 *
 * Fetches all contacts once and filters locally so the agent can ask
 * "find Alice" or "find contacts on Base" without knowing exact ids.
 *
 * Input: one or more optional filter fields —
 *   - `query?: string`      — case-insensitive substring match on label,
 *                             address, ens_name, and notes
 *   - `chain_name?: string` — exact (case-insensitive) match on chainName
 *   - `is_evm?: boolean`    — filter by EVM / non-EVM
 *
 * At least one filter must be provided.
 *
 * Returns: `{ contacts: Contact[], total: number }`
 */
export const searchAddressBook: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const query = optionalString(input, "query")?.toLowerCase();
    const chainName = optionalString(input, "chain_name")?.toLowerCase();
    const isEvm = typeof input.is_evm === "boolean" ? input.is_evm : undefined;

    if (!query && !chainName && isEvm === undefined) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "at least one of query, chain_name, or is_evm must be provided",
      );
    }

    let entries: TAddressBookEntry[];
    try {
      entries = await addressBookApi.getAll();
    } catch (err) {
      logExecutorDetail("address book fetch failed", err);
      throw new ExecutorError(
        ExecutorErrorCode.NetworkError,
        "address_book_unavailable",
      );
    }

    const results = entries.filter((e) => {
      if (isEvm !== undefined && e.isEvm !== isEvm) return false;
      if (chainName && (e.chainName ?? "").toLowerCase() !== chainName)
        return false;
      if (query) {
        const haystack = [e.label, e.address, e.ensName ?? "", e.notes ?? ""]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    return {
      status: "success",
      data: {
        contacts: results.map(projectEntry),
        total: results.length,
      },
    };
  });

// ---------------------------------------------------------------------------
// Registry export
// ---------------------------------------------------------------------------

export const ADDRESS_BOOK_EXECUTORS: Record<string, MobileToolExecutor> = {
  get_address_book: getAddressBook,
  get_address_book_entry: getAddressBookEntry,
  search_address_book: searchAddressBook,
};
