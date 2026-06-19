import { useEffect, useRef } from "react";
import { View, Animated } from "react-native";
import type { TaskStatus } from "@harness/shared";
import { STATUS_META } from "@/lib/constants";
import { useTheme } from "@/lib/theme";

const W = 3;

// Signature element: a vertical "signal bar" beside each task that encodes status
// as information rather than decoration.
//   running → a slow breathing pulse (the agent is alive, working)
//   done    → solid
//   failed  → broken (a gap in the middle)
//   queued  → dashed (waiting)
//   else    → solid, dimmer
export function SignalBar({ status, height = 38 }: { status: TaskStatus; height?: number }) {
  const theme = useTheme();
  const color = STATUS_META[status]?.color ?? theme.faint;

  if (status === "running") return <PulseBar color={color} height={height} />;
  if (status === "failed") return <BrokenBar color={color} height={height} />;
  if (status === "queued") return <DashedBar color={color} height={height} />;

  return <View style={{ width: W, height, borderRadius: W / 2, backgroundColor: color }} />;
}

function PulseBar({ color, height }: { color: string; height: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 850, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  return (
    <Animated.View
      style={{
        width: W,
        height,
        borderRadius: W / 2,
        backgroundColor: color,
        opacity,
        shadowColor: color,
        shadowOpacity: 0.7,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 0 },
      }}
    />
  );
}

function BrokenBar({ color, height }: { color: string; height: number }) {
  const seg = (height - 5) / 2;
  return (
    <View style={{ width: W, height, justifyContent: "space-between" }}>
      <View style={{ width: W, height: seg, borderRadius: W / 2, backgroundColor: color }} />
      <View style={{ width: W, height: seg, borderRadius: W / 2, backgroundColor: color }} />
    </View>
  );
}

function DashedBar({ color, height }: { color: string; height: number }) {
  const dashes = 4;
  const gap = 3;
  const dh = (height - gap * (dashes - 1)) / dashes;
  return (
    <View style={{ width: W, height, justifyContent: "space-between" }}>
      {Array.from({ length: dashes }).map((_, i) => (
        <View key={i} style={{ width: W, height: dh, borderRadius: W / 2, backgroundColor: color, opacity: 0.7 }} />
      ))}
    </View>
  );
}
