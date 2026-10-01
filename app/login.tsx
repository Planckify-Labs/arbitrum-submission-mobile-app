import { router } from "expo-router";
import {
  ChevronRight,
  Fingerprint,
  KeyRound,
  Plus,
  ShieldCheck,
} from "lucide-react-native";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import ImportPrivateKeySheet from "@/components/wallet/create/ImportPrivateKeySheet";
import ImportSeedPhraseSheet from "@/components/wallet/create/ImportSeedPhraseSheet";
import {
  FEATURE_PASSKEY_ONBOARDING,
  FEATURE_PASSKEY_ONLY_ONBOARDING,
} from "@/constants/configs/featureFlags";
import type { TWallet } from "@/constants/types/walletTypes";
import { useBiometricLabel } from "@/hooks/useBiometricLabel";
import { useGoogleWalletAuth } from "@/hooks/useGoogleWalletAuth";
import { useLoadingSteps } from "@/hooks/useLoadingSteps";
import { usePasskeyOnboarding } from "@/hooks/usePasskeyOnboarding";
import { useWallet } from "@/hooks/useWallet";
import { bootstrapFirstLoginWallets } from "@/services/walletKit/bootstrap";

export default function Login() {
  const { height } = useWindowDimensions();
  const scrollViewRef = useRef<ScrollView>(null);
  const { addWallets } = useWallet();
  const [creating, setCreating] = useState(false);
  const [seedSheetVisible, setSeedSheetVisible] = useState(false);
  const [pkSheetVisible, setPkSheetVisible] = useState(false);
  const {
    isLoading: isCreatingSpinner,
    currentMessage: creatingMessage,
    completeStep,
    start: startCreating,
    stop: stopCreating,
    delay,
  } = useLoadingSteps([
    "Setting things up for you...",
    "Generating your wallets...",
    "Securing your keys...",
    "You're all set! 🎉",
  ]);

  // Separate step track for the Google path — a returning user isn't
  // "generating wallets", so the create-wallet copy would be a lie.
  const {
    isLoading: isSigningInSpinner,
    currentMessage: signingInMessage,
    completeStep: completeSignInStep,
    start: startSigningIn,
    stop: stopSigningIn,
    delay: signInDelay,
  } = useLoadingSteps([
    "Verifying your account...",
    "Setting up your wallet...",
    "Signing you in...",
    "You're all set! 🎉",
  ]);

  // The Google flow itself lives in `useGoogleWalletAuth`, shared with the
  // in-app add-wallet sheet so the account-resolution rules (never mint over
  // a Drive backup, never co-opt an unrelated wallet) exist in ONE place.
  // Only the screen-specific parts are supplied here.
  const google = useGoogleWalletAuth({
    onStep: completeSignInStep,
    onStart: startSigningIn,
    onStop: stopSigningIn,
    delay: signInDelay,
    // This is the piece a sheet cannot share: login lands on home.
    onComplete: () => {
      router.replace("/");
    },
    onRequestSeedPhrase: () => setSeedSheetVisible(true),
    onError: (title, message) => Alert.alert(title, message),
  });

  // Mera passkey onboarding (docs/monad-metropolis-2026-spec.md §3.5).
  // Same host/hook split as Google: the hook owns the ceremony, wallet
  // placement and the silent session handshake; this screen owns the
  // progress copy and where to land afterwards.
  const {
    isLoading: isPasskeySpinner,
    currentMessage: passkeyMessage,
    completeStep: completePasskeyStep,
    start: startPasskey,
    stop: stopPasskey,
    delay: passkeyDelay,
  } = useLoadingSteps([
    "Verified, welcome...",
    "Setting up your account...",
    "Almost there...",
    "You're all set! 🎉",
  ]);
  const biometric = useBiometricLabel();
  const passkey = usePasskeyOnboarding({
    onStep: completePasskeyStep,
    onStart: startPasskey,
    onStop: stopPasskey,
    delay: passkeyDelay,
    onComplete: () => {
      router.replace("/");
    },
    onError: (copy) => Alert.alert(copy.title, copy.message),
    onConfirmFirstTime: () =>
      new Promise<boolean>((resolve) =>
        Alert.alert(
          "First time here?",
          "If you've used TakumiPay before, tap Continue again and choose your account. Otherwise we'll set up a new one.",
          [
            { text: "Not now", style: "cancel", onPress: () => resolve(false) },
            { text: "Set up new account", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      ),
  });
  const anyBusy = creating || google.isStarting || passkey.busy !== null;
  // A phone that can't run the ceremony (no platform passkeys, or a
  // binary without the native module) would only ever get an error
  // dialog from the button, so it isn't offered. Passkey-only builds keep
  // it regardless: it is the only way in, and its error says why.
  const showPasskey =
    FEATURE_PASSKEY_ONBOARDING &&
    (passkey.supported || FEATURE_PASSKEY_ONLY_ONBOARDING);

  const handleCreateWallet = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    startCreating();
    try {
      completeStep(0);
      await delay(200);

      completeStep(1);
      const minted = await bootstrapFirstLoginWallets();
      if (minted.length === 0) {
        stopCreating();
        Alert.alert(
          "Create Failed",
          "Could not create a wallet. Please try again.",
        );
        return;
      }

      completeStep(2);
      await addWallets(minted);

      completeStep(3);
      await delay(300);

      router.replace("/");
    } catch (error) {
      console.error("create wallet failed:", error);
      stopCreating();
      Alert.alert(
        "Create Failed",
        "Could not create a wallet. Please try again.",
      );
    } finally {
      setCreating(false);
    }
  }, [creating, addWallets, startCreating, stopCreating, completeStep, delay]);

  const handleSeedWalletsAdded = useCallback(
    (added: TWallet[]) => {
      setSeedSheetVisible(false);

      // No-op unless this import WAS the Google recovery path; the hook owns
      // that decision (and the access token it needs) so the rule isn't
      // duplicated here.
      google.completeSeedPhraseRecovery(added);
      router.replace("/");
    },
    [google],
  );

  const handlePrivateKeyWalletAdded = useCallback((_: unknown) => {
    setPkSheetVisible(false);
    router.replace("/");
  }, []);

  const handleImportSeedPhraseInstead = useCallback(() => {
    setPkSheetVisible(false);
    // A plain import, not the Google recovery path — clear any pending
    // recovery so these wallets don't get tagged to the account.
    google.cancelSeedPhraseRecovery();
    setSeedSheetVisible(true);
  }, [google]);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        style={{ paddingTop: 0 }}
      >
        <View style={[StyleSheet.absoluteFill]} className="overflow-hidden">
          <View className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-light-primary-red/10" />
          <View className="absolute top-40 -left-40 w-80 h-80 rounded-full bg-light-primary-red/5" />
          <View className="absolute -bottom-10 -right-14 w-40 h-40 rounded-full bg-light-primary-red/10" />
        </View>

        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={[
            { minHeight: height },
            styles.scrollViewContent,
          ]}
          showsVerticalScrollIndicator={false}
          scrollEnabled={false}
          onContentSizeChange={(_, contentHeight) => {
            if (scrollViewRef.current) {
              scrollViewRef.current.setNativeProps({
                scrollEnabled: contentHeight > height,
              });
            }
          }}
        >
          <View className="flex-1 p-6">
            <View className="items-center mb-16">
              <View className="bg-light shadow-lg- py-5 justify-center items-center aspect-square rounded-3xl mb-6">
                <Image
                  source={require("@/assets/images/takumipay-no-bg.png")}
                  style={{ width: 65, height: 60 }}
                  className="object-contain w-full"
                />
              </View>

              <Text className="text-light-matte-black text-4xl font-bold text-center mb-2">
                TakumiPay
              </Text>
              <Text className="text-light-matte-black/70 text-base text-center max-w-72">
                Your Financial AI Companion
              </Text>
            </View>

            {/*
              Hierarchy, top to bottom:
                1. Passkey: the one filled button. No password, no seed
                   phrase, works on any phone signed in to the same
                   password manager.
                2. Google: outlined, same card, equal standing as a
                   "get started" path.
                3. Other ways: quiet rows for people who want to hold a
                   recovery phrase themselves (create, or bring one).
              When the passkey path can't run on this phone it drops out
              and Google is the card's only button.
            */}
            <View className="bg-light rounded-3xl p-6 shadow-md- mb-8">
              <Text className="text-light-matte-black/80 font-medium mb-4">
                GET STARTED
              </Text>

              {showPasskey ? (
                // One button. The hook asserts against any TakumiPay
                // passkey already on this device / Google account (pinned
                // to the last one used here when known, else the OS
                // picker) and only creates a new one when the OS reports
                // there is none. The user never has to know which
                // ceremony ran. Dev-only: long-press runs the GPM probes
                // in services/walletKit/evm/mera/diagnose.ts.
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-primary-red py-4 px-5 rounded-xl flex-row items-center justify-between"
                  onPress={passkey.continue}
                  onLongPress={
                    __DEV__
                      ? () => {
                          void import(
                            "@/services/walletKit/evm/mera/diagnose"
                          ).then((m) => m.runPasskeyDiagnostics());
                        }
                      : undefined
                  }
                  disabled={anyBusy}
                  accessibilityRole="button"
                  accessibilityLabel={biometric.cta}
                >
                  <View className="flex-row items-center flex-1 mr-3">
                    <View className="w-11 h-11 bg-light/20 rounded-full items-center justify-center mr-3">
                      {passkey.busy ? (
                        <ActivityIndicator size="small" color="#ffffff" />
                      ) : (
                        <Fingerprint color="#ffffff" size={20} />
                      )}
                    </View>
                    <View className="flex-1">
                      <Text className="text-light font-semibold">
                        {passkey.busy ? "Unlocking…" : biometric.cta}
                      </Text>
                      <Text className="text-light/70 text-xs">
                        No password or seed phrase to keep
                      </Text>
                    </View>
                  </View>
                  <ChevronRight color="#ffffff" size={18} />
                </TouchableOpacity>
              ) : null}

              {FEATURE_PASSKEY_ONLY_ONBOARDING ? null : (
                <TouchableOpacity
                  activeOpacity={0.7}
                  className={`bg-light border border-light-matte-black/10 py-4 px-5 rounded-xl flex-row items-center justify-between${showPasskey ? " mt-3" : ""}`}
                  onPress={google.start}
                  disabled={anyBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with Google"
                >
                  <View className="flex-row items-center">
                    <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
                      {google.isStarting ? (
                        <ActivityIndicator size="small" color="#c71c4b" />
                      ) : (
                        <Image
                          source={require("@/assets/images/google-takumipay.png")}
                          style={{ width: 20, height: 20 }}
                        />
                      )}
                    </View>
                    <Text className="text-light-matte-black font-medium">
                      {google.isStarting
                        ? "Signing in..."
                        : "Continue with Google"}
                    </Text>
                  </View>
                  <ChevronRight color="#20222c" size={18} />
                </TouchableOpacity>
              )}

              {showPasskey ? (
                <Text className="text-light-matte-black/50 text-xs text-center mt-4">
                  Secured by your {biometric.noun}. Nothing to write down.
                </Text>
              ) : null}
            </View>

            {FEATURE_PASSKEY_ONLY_ONBOARDING ? null : (
              <View className="mb-8">
                <Text className="text-light-matte-black/60 text-xs font-medium uppercase tracking-wide px-2 mb-1">
                  Other ways
                </Text>
                <Text className="text-light-matte-black/40 text-xs px-2 mb-3">
                  For a recovery phrase you keep yourself
                </Text>

                <View className="bg-light/60 rounded-2xl overflow-hidden">
                  <OtherWayRow
                    icon={
                      creating ? (
                        <ActivityIndicator size="small" color="#c71c4b" />
                      ) : (
                        <Plus color="#c71c4b" size={16} />
                      )
                    }
                    title={creating ? "Creating wallet…" : "Create new wallet"}
                    subtitle="New recovery phrase, every chain"
                    onPress={handleCreateWallet}
                    disabled={anyBusy}
                  />
                  <OtherWayRow
                    icon={<ShieldCheck color="#c71c4b" size={16} />}
                    title="Import seed phrase"
                    subtitle="12 or 24 words, derives every chain"
                    onPress={() => {
                      google.cancelSeedPhraseRecovery();
                      setSeedSheetVisible(true);
                    }}
                    disabled={anyBusy}
                    divider
                  />
                  <OtherWayRow
                    icon={<KeyRound color="#c71c4b" size={16} />}
                    title="Import private key"
                    subtitle="One chain: EVM or Solana"
                    onPress={() => setPkSheetVisible(true)}
                    disabled={anyBusy}
                    divider
                  />
                </View>
              </View>
            )}

            <View className="items-center mt-auto">
              <Text className="text-light-matte-black/50 text-xs text-center max-w-80">
                By continuing, you agree to our Terms of Service and Privacy
                Policy
              </Text>
            </View>
          </View>
        </ScrollView>

        <ImportSeedPhraseSheet
          visible={seedSheetVisible}
          onClose={() => {
            setSeedSheetVisible(false);
            google.cancelSeedPhraseRecovery();
          }}
          onWalletsAdded={handleSeedWalletsAdded}
          tagSocial={google.seedRecoveryAccount}
        />
        <ImportPrivateKeySheet
          visible={pkSheetVisible}
          onClose={() => setPkSheetVisible(false)}
          onWalletAdded={handlePrivateKeyWalletAdded}
          onImportSeedPhraseInstead={handleImportSeedPhraseInstead}
        />

        {/* OTP + Drive-restore + "Account found", owned by the shared hook so
            the in-app add-wallet sheet gets the identical flow. */}
        {google.sheets}

        <LoadinngSpinnerPopup
          visible={isCreatingSpinner}
          title="Creating Wallet"
          message={creatingMessage}
        />

        <LoadinngSpinnerPopup
          visible={isSigningInSpinner}
          title="Signing In"
          message={signingInMessage}
        />

        <LoadinngSpinnerPopup
          visible={isPasskeySpinner}
          title="Setting Up"
          message={passkeyMessage}
        />
      </SafeAreaView>
    </>
  );
}

type TOtherWayRowProps = {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onPress: () => void;
  disabled: boolean;
  /** Hairline above the row; every row but the first. */
  divider?: boolean;
};

function OtherWayRow({
  icon,
  title,
  subtitle,
  onPress,
  disabled,
  divider,
}: TOtherWayRowProps) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      className={`flex-row items-center justify-between px-4 py-3.5${divider ? " border-t border-light-matte-black/5" : ""}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View className="flex-row items-center flex-1 mr-3">
        <View className="w-9 h-9 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          {icon}
        </View>
        <View className="flex-1">
          <Text className="text-light-matte-black font-medium text-sm">
            {title}
          </Text>
          <Text className="text-light-matte-black/50 text-xs">{subtitle}</Text>
        </View>
      </View>
      <ChevronRight color="#20222c" size={16} opacity={0.5} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scrollViewContent: {
    flexGrow: 1,
  },
});
