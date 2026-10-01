import { Check } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { TCreateAddressBookDto } from "@/api/types/addressBook";
import { ApiConflictError } from "@/api/types/errors";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";

const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

function validateAddressField(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return "Address is required";
  if (/\s/.test(trimmed)) return "Address must not contain spaces";
  if (trimmed.startsWith("0x")) {
    if (!EVM_ADDRESS_REGEX.test(trimmed)) {
      return "Invalid EVM address (must be 0x + 40 hex characters)";
    }
  } else if (trimmed.length < 25) {
    return "Address is too short";
  } else if (trimmed.length > 128) {
    return "Address is too long";
  }
  return null;
}

function resolveApiError(
  error: Error | null,
): { message: string; isDuplicate: boolean } | null {
  if (!error) return null;
  const isDuplicate = error instanceof ApiConflictError;
  return {
    isDuplicate,
    message: isDuplicate
      ? "This address is already in your address book."
      : "Something went wrong. Please try again.",
  };
}

type AddContactPrefill = {
  address?: string;
  chainName?: string;
};

type AddContactModalProps = {
  visible: boolean;
  onClose: () => void;
  onSave: (dto: TCreateAddressBookDto) => void;
  editing?: TAddressBookEntry | null;
  prefill?: AddContactPrefill;
  isSaving?: boolean;
  saveError?: Error | null;
};

export default function AddContactModal({
  visible,
  onClose,
  onSave,
  editing,
  prefill,
  isSaving = false,
  saveError,
}: AddContactModalProps) {
  const [contactLabel, setContactLabel] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [ensName, setEnsName] = useState("");
  const [contactNotes, setContactNotes] = useState("");
  const [chainName, setChainName] = useState("");
  const [contactLabelError, setContactLabelError] = useState("");
  const [walletAddressError, setWalletAddressError] = useState("");

  const contactLabelInputRef = useRef<TextInput>(null);
  const prevVisible = useRef(false);

  // Pre-fill the form once each time the sheet opens (false -> true).
  useEffect(() => {
    if (visible && !prevVisible.current) {
      setContactLabel(editing?.label ?? "");
      setWalletAddress(editing?.address ?? prefill?.address ?? "");
      setEnsName(editing?.ensName ?? "");
      setContactNotes(editing?.notes ?? "");
      setChainName(editing?.chainName ?? prefill?.chainName ?? "");
      setContactLabelError("");
      setWalletAddressError("");
    }
    prevVisible.current = visible;
  }, [visible, editing, prefill]);

  const isEvmAddress = walletAddress.trim().startsWith("0x");

  const validateForm = (): boolean => {
    let isValid = true;
    const trimmedLabel = contactLabel.trim();

    if (!trimmedLabel) {
      setContactLabelError("Name is required");
      isValid = false;
    } else if (trimmedLabel.length > 32) {
      setContactLabelError("Max 32 characters");
      isValid = false;
    } else {
      setContactLabelError("");
    }

    const addressError = validateAddressField(walletAddress);
    if (addressError) {
      setWalletAddressError(addressError);
      isValid = false;
    } else {
      setWalletAddressError("");
    }

    return isValid;
  };

  const handleSubmit = () => {
    if (!validateForm()) return;

    const payload: TCreateAddressBookDto = {
      label: contactLabel.trim(),
      address: walletAddress.trim(),
      isEvm: isEvmAddress,
    };
    if (isEvmAddress && ensName.trim()) payload.ensName = ensName.trim();
    if (contactNotes.trim()) payload.notes = contactNotes.trim();
    if (chainName.trim()) payload.chainName = chainName.trim();

    onSave(payload);
  };

  const isEditMode = !!editing;
  const apiError = resolveApiError(saveError ?? null);

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      onOpened={() => contactLabelInputRef.current?.focus()}
      height="88%"
      borderRadius={28}
    >
      <ModalHeader
        title={isEditMode ? "Edit Contact" : "Add Contact"}
        className="px-6"
      />

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}
      >
        {/* Inline API error — message is always user-friendly, never a raw HTTP response */}
        {apiError && (
          <View
            className="rounded-xl p-3 mb-4"
            style={{
              backgroundColor: apiError.isDuplicate ? "#c71c4b15" : "#20222c0a",
            }}
          >
            <Text
              className="text-[13px] font-medium"
              style={{
                color: apiError.isDuplicate ? "#c71c4b" : "#20222c99",
              }}
            >
              {
                apiError.message /* safe-error-ok: fixed copy from resolveApiError */
              }
            </Text>
          </View>
        )}

        {/* Contact name */}
        <View className="mb-4">
          <Text className="text-sm text-light-matte-black/70 mb-2">Name *</Text>
          <TextInput
            ref={contactLabelInputRef}
            value={contactLabel}
            onChangeText={(value) => {
              setContactLabel(value);
              if (contactLabelError) setContactLabelError("");
            }}
            placeholder="e.g. Alice, Exchange Hot Wallet"
            placeholderTextColor="#20222c40"
            maxLength={32}
            editable={!isSaving}
            returnKeyType="next"
            className="bg-white rounded-xl px-4 py-[14px] text-[15px] text-light-matte-black"
            style={{
              borderWidth: 1,
              borderColor: contactLabelError ? "#e53e3e" : "#c71c4b33",
            }}
          />
          {contactLabelError ? (
            <Text className="text-[11px] text-red-500 mt-1">
              {contactLabelError}
            </Text>
          ) : (
            <Text className="text-[11px] text-light-matte-black/30 mt-1 text-right">
              {contactLabel.length}/32
            </Text>
          )}
        </View>

        {/* Wallet address (EVM or non-EVM) */}
        <View className="mb-4">
          <Text className="text-sm text-light-matte-black/70 mb-2">
            Wallet Address *
          </Text>
          <TextInput
            value={walletAddress}
            onChangeText={(value) => {
              setWalletAddress(value);
              if (walletAddressError) setWalletAddressError("");
            }}
            placeholder="0x... or base58 (Solana, etc.)"
            placeholderTextColor="#20222c40"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isSaving}
            returnKeyType="next"
            className="bg-white rounded-xl px-4 py-[14px] text-[13px] text-light-matte-black"
            style={{
              borderWidth: 1,
              borderColor: walletAddressError ? "#e53e3e" : "#c71c4b33",
              fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
            }}
          />
          {!!walletAddressError && (
            <Text className="text-[11px] text-red-500 mt-1">
              {walletAddressError}
            </Text>
          )}
        </View>

        {/* ENS domain — EVM only */}
        {isEvmAddress && (
          <View className="mb-4">
            <Text className="text-sm text-light-matte-black/70 mb-2">
              ENS Name
            </Text>
            <TextInput
              value={ensName}
              onChangeText={setEnsName}
              placeholder="e.g. vitalik.eth"
              placeholderTextColor="#20222c40"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSaving}
              returnKeyType="next"
              className="bg-white rounded-xl px-4 py-[14px] text-[15px] text-light-matte-black"
              style={{ borderWidth: 1, borderColor: "#c71c4b33" }}
            />
          </View>
        )}

        {/* Blockchain network name (optional) */}
        <View className="mb-4">
          <Text className="text-sm text-light-matte-black/70 mb-2">Chain</Text>
          <TextInput
            value={chainName}
            onChangeText={setChainName}
            placeholder="e.g. Ethereum, Solana, Polygon, Base"
            placeholderTextColor="#20222c40"
            autoCapitalize="words"
            autoCorrect={false}
            editable={!isSaving}
            returnKeyType="next"
            className="bg-white rounded-xl px-4 py-[14px] text-[15px] text-light-matte-black"
            style={{ borderWidth: 1, borderColor: "#c71c4b33" }}
          />
        </View>

        {/* Free-form notes about this contact (optional) */}
        <View className="mb-5">
          <Text className="text-sm text-light-matte-black/70 mb-2">Notes</Text>
          <TextInput
            value={contactNotes}
            onChangeText={setContactNotes}
            placeholder="e.g. Main savings wallet, don't reuse"
            placeholderTextColor="#20222c40"
            multiline
            numberOfLines={3}
            editable={!isSaving}
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
            className="bg-white rounded-xl px-4 pt-3 pb-[14px] text-[15px] text-light-matte-black"
            style={{
              borderWidth: 1,
              borderColor: "#c71c4b33",
              minHeight: 72,
              textAlignVertical: "top",
            }}
          />
        </View>

        {/* Cancel / Save buttons */}
        <View className="flex-row gap-3 mb-2">
          <Pressable
            onPress={onClose}
            disabled={isSaving}
            className="flex-1 bg-white rounded-xl py-[15px] items-center"
            style={{ borderWidth: 1, borderColor: "#20222c15" }}
          >
            <Text className="text-[15px] font-semibold text-light-matte-black">
              Cancel
            </Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={isSaving}
            className="flex-1 rounded-xl py-[15px] flex-row items-center justify-center gap-1.5"
            style={{ backgroundColor: isSaving ? "#c71c4b80" : "#c71c4b" }}
          >
            <Check size={16} color="white" />
            <Text className="text-[15px] font-semibold text-white">
              {isSaving
                ? "Saving..."
                : isEditMode
                  ? "Save Changes"
                  : "Add Contact"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </BaseModal>
  );
}
