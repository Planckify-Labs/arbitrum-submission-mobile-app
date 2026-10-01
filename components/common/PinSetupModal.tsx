import { Delete, Lock, Shield } from "lucide-react-native";
import React, { useEffect, useState } from "react";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { errorFeedback, tapFeedback } from "@/utils/hapticsUtils";

interface PinSetupModalProps {
  visible: boolean;
  onClose: () => void;
  onSetupComplete: (pin: string) => void;
  pinLength?: number;
}

const PinSetupModal: React.FC<PinSetupModalProps> = ({
  visible,
  onClose,
  onSetupComplete,
  pinLength = 4,
}) => {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [step, setStep] = useState<"intro" | "create" | "confirm">("intro");
  const [error, setError] = useState("");

  // Reset the flow each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setPin("");
      setConfirmPin("");
      setStep("intro");
      setError("");
    }
  }, [visible]);

  const handlePinDigit = (digit: string) => {
    const currentPin = step === "create" ? pin : confirmPin;
    if (currentPin.length >= pinLength) return;

    tapFeedback();

    if (step === "create") {
      if (pin.length < pinLength) {
        setPin((prev) => prev + digit);
        setError("");

        if (pin.length === pinLength - 1) {
          setTimeout(() => {
            setStep("confirm");
          }, 300);
        }
      }
    } else if (step === "confirm") {
      if (confirmPin.length < pinLength) {
        setConfirmPin((prev) => prev + digit);
        setError("");
      }
    }
  };

  const handleDelete = () => {
    if (step === "create" && pin.length > 0) {
      setPin((prev) => prev.slice(0, -1));
    } else if (step === "confirm" && confirmPin.length > 0) {
      setConfirmPin((prev) => prev.slice(0, -1));
    }
  };

  const handleConfirm = () => {
    if (step === "intro") {
      setStep("create");
      return;
    }

    if (step === "create") {
      if (pin.length < pinLength) {
        setError(`PIN must be ${pinLength} digits`);
        return;
      }
      setStep("confirm");
    } else {
      if (confirmPin.length < pinLength) {
        setError(`PIN must be ${pinLength} digits`);
        return;
      }

      if (pin !== confirmPin) {
        errorFeedback();
        setError("PINs don't match. Please try again.");
        setConfirmPin("");
        return;
      }

      onSetupComplete(pin);
    }
  };

  const renderPinDots = () => {
    const currentPin = step === "create" ? pin : confirmPin;
    const dots = [];
    for (let i = 0; i < pinLength; i++) {
      dots.push(
        <View
          key={i}
          className={`h-4 w-4 rounded-full mx-2 ${
            i < currentPin.length
              ? "bg-light-primary-red"
              : "bg-light-matte-black/20"
          }`}
        />,
      );
    }
    return dots;
  };

  const renderNumberPad = () => {
    const numbers = [
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["7", "8", "9"],
      ["", "0", "delete"],
    ];

    return numbers.map((row, rowIndex) => (
      <View
        key={rowIndex}
        className="flex-row justify-around flex-1 my-2 gap-2"
      >
        {row.map((num, colIndex) => {
          if (num === "") {
            return <View key={colIndex} className="w-16 h-16" />;
          }

          if (num === "delete") {
            return (
              <TouchableOpacity
                key={colIndex}
                className="w-16 h-16 rounded-full justify-center items-center"
                onPress={handleDelete}
              >
                <Delete size={24} color="#c71c4b" />
              </TouchableOpacity>
            );
          }

          return (
            <TouchableOpacity
              key={colIndex}
              className="w-16 h-16 rounded-full bg-light-main-container justify-center items-center"
              onPress={() => handlePinDigit(num)}
            >
              <Text className="text-light-matte-black text-2xl font-medium">
                {num}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    ));
  };

  const renderIntroScreen = () => (
    <View className="bg-white rounded-3xl p-6 shadow-sm mb-5">
      <View className="items-center mb-6">
        <View className="bg-light-primary-red/10 p-4 rounded-full mb-4">
          <Lock size={40} color="#c71c4b" />
        </View>
        <Text className="text-light-matte-black text-xl font-bold mb-2">
          Security First
        </Text>
        <Text className="text-light-matte-black/70 text-center">
          You need to set up a PIN before making transactions
        </Text>
      </View>

      <View className="bg-light-primary-red/10 p-4 rounded-xl mb-6">
        <Text className="text-light-matte-black/80 text-sm mb-3 font-medium">
          Why is this important?
        </Text>
        <View className="flex-row items-start mb-2">
          <Shield size={16} color="#c71c4b" className="mr-2 mt-0.5" />
          <Text className="text-light-matte-black/70 text-sm flex-1">
            Protects your wallet from unauthorized access
          </Text>
        </View>
        <View className="flex-row items-start mb-2">
          <Shield size={16} color="#c71c4b" className="mr-2 mt-0.5" />
          <Text className="text-light-matte-black/70 text-sm flex-1">
            Adds an extra layer of security for all transactions
          </Text>
        </View>
        <View className="flex-row items-start">
          <Shield size={16} color="#c71c4b" className="mr-2 mt-0.5" />
          <Text className="text-light-matte-black/70 text-sm flex-1">
            Prevents accidental or unauthorized transfers
          </Text>
        </View>
      </View>
    </View>
  );

  const renderCreatePinScreen = () => (
    <View className="bg-white rounded-3xl p-6 shadow-sm mb-5">
      <Text className="text-light-matte-black/70 mb-6 text-center">
        Please create a PIN to secure your wallet
      </Text>

      <View className="flex-row justify-center items-center mb-6">
        {renderPinDots()}
      </View>

      {error ? (
        <Text className="text-light-primary-red mb-4 text-center">{error}</Text>
      ) : null}

      <View className="items-center">{renderNumberPad()}</View>
    </View>
  );

  const renderConfirmPinScreen = () => (
    <View className="bg-white rounded-3xl p-6 shadow-sm mb-5">
      <Text className="text-light-matte-black/70 mb-6 text-center">
        Please confirm your PIN
      </Text>

      <View className="flex-row justify-center items-center mb-6">
        {renderPinDots()}
      </View>

      {error ? (
        <Text className="text-light-primary-red mb-4 text-center">{error}</Text>
      ) : null}

      <View className="items-center">{renderNumberPad()}</View>
    </View>
  );

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height="auto"
      borderRadius={28}
      contentClassName="px-6 pb-2"
    >
      <ModalHeader
        title={
          step === "intro"
            ? "Security Setup"
            : step === "create"
              ? "Create PIN"
              : "Confirm PIN"
        }
      />

      {step === "intro" && renderIntroScreen()}
      {step === "create" && renderCreatePinScreen()}
      {step === "confirm" && renderConfirmPinScreen()}

      <Pressable
        className={`bg-light-primary-red py-4 rounded-xl items-center ${
          (step === "create" && pin.length < pinLength) ||
          (step === "confirm" && confirmPin.length < pinLength)
            ? "opacity-50"
            : ""
        }`}
        onPress={handleConfirm}
        disabled={
          (step === "create" && pin.length < pinLength) ||
          (step === "confirm" && confirmPin.length < pinLength)
        }
      >
        <Text className="text-white font-bold">
          {step === "intro"
            ? "Set Up PIN"
            : step === "create"
              ? "Next"
              : "Confirm"}
        </Text>
      </Pressable>
    </BaseModal>
  );
};

export default PinSetupModal;
