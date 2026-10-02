# TakumiPay mobile app (Arbitrum submission)

> Part of the TakumiPay submission to the Arbitrum Open House Singapore Online Buildathon. Start at the hub: **[https://github.com/Planckify-Labs/arbitrum-submission](https://github.com/Planckify-Labs/arbitrum-submission)** (fact sheet, deployments with transaction hashes, known limitations, reproduction commands).

**Role of this repository:** React Native + Expo wallet: passkey login, USDG send/receive, points deposit, bill and merchant payment, Takumi Agent chat.

**Chains:** Arbitrum One (42161), Arbitrum Sepolia (421614), Robinhood Chain testnet (46630). **Stablecoin:** Paxos USDG. **License:** GPL-3.0.

## Where to look
- Passkey wallet: `services/walletKit/evm/mera/`
- Arbitrum and Robinhood chain focus: `services/chains/evm/arbitrumStack.ts`, `services/walletKit/chainSupport.ts`, flag `FEATURE_CHAIN_LOCKDOWN` in `constants/configs/featureFlags.ts`
- USDG-only stablecoin filter (matched by contract address): `services/tokens/tokenSupport.ts`
- Agent chat UI: `components/home/TakumiAgent/`
- On-chain settlement path: `services/nanopay/pathOnchainSettlement.ts`
- Architecture notes for contributors: `CLAUDE.md`

## Run
```bash
pnpm install
pnpm start
```
Test the Android preview build on a physical device with biometrics. Passkey derivation needs the WebAuthn PRF extension, which emulators usually lack. Download link is in the hub README.

Other chains (Solana, Sui, Stellar, Monad, Arc) remain in the code but are hidden in this build by `FEATURE_CHAIN_LOCKDOWN`.

---

# TakumiPay (mobile)

## Official distribution channels (TWV-2026-065)

These are the **only** places a genuine TakumiPay binary is ever
published. If you found a "Takumi" installer somewhere that is not
listed here — a paid search ad, a sideloaded `.apk`, a desktop app, a
browser extension — it is not ours. Do not install it.

- **Google Play Store:** https://play.google.com/store/apps/details?id=com.planckify.takumiwallet
- **Website:** https://takumipay.xyz

App identifiers:

- **iOS Bundle ID:** `com.planckify.takumiwallet`
- **Android Package:** `com.planckify.takumiwallet`
- **Signing-cert SHA-256:** shown in the in-app **About** screen (Wallet
  tab → About). Users can compare the published fingerprint to what the
  OS reports. The value in `constants/about.ts` is the source of truth;
  updates require security-team review.

Distribution-discipline notes:
`docs/distribution-discipline.md` (public runbook excerpt) and the
private ops folder (full impersonation-monitoring runbook).

## Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Troubleshooting

### EAS Build Errors

If you encounter the following error during EAS build:

```
Build failed
pnpm install --frozen-lockfile exited with non-zero code: 1
```

**Temporary solution:**
- For EAS builds: Delete the pnpm lock file before building
- For local machine: Run the following command:
  ```bash
  pnpm install --no-frozen-lockfile --ignore-scripts
  ```

## Building the App

### Development Build

To create a development build for Android:

```bash
eas build --platform android --profile development
```

This command will build the app using the development profile defined in your eas.json file, which includes development client features for testing.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.


