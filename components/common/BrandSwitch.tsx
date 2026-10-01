/**
 * On/off switch in the app's own visual language: brand-red pill when on,
 * soft matte-black track when off, white thumb. RN's `Switch` renders the
 * platform control (Material grey thumb on Android) and only lets us tint
 * the track, so it never matched the rest of the UI.
 */

import { memo, useEffect } from "react";
import { Pressable } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const TRACK_WIDTH = 44;
const TRACK_HEIGHT = 26;
const THUMB_SIZE = 20;
const PADDING = (TRACK_HEIGHT - THUMB_SIZE) / 2;
const TRAVEL = TRACK_WIDTH - THUMB_SIZE - PADDING * 2;

const TRACK_OFF = "rgba(32, 34, 44, 0.15)";
const TRACK_ON = "#c71c4b";

export type BrandSwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

function BrandSwitchBase({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: BrandSwitchProps) {
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, { duration: 180 });
  }, [value, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [TRACK_OFF, TRACK_ON],
    ),
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * TRAVEL }],
  }));

  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Animated.View
        style={[
          {
            width: TRACK_WIDTH,
            height: TRACK_HEIGHT,
            borderRadius: TRACK_HEIGHT / 2,
            padding: PADDING,
          },
          trackStyle,
        ]}
      >
        <Animated.View
          style={[
            {
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              borderRadius: THUMB_SIZE / 2,
              backgroundColor: "#fff",
              shadowColor: "#20222c",
              shadowOpacity: 0.2,
              shadowRadius: 2,
              shadowOffset: { width: 0, height: 1 },
              elevation: 2,
            },
            thumbStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

export const BrandSwitch = memo(BrandSwitchBase);
export default BrandSwitch;
