// template
import type { ComponentType } from "react";
import { Platform, ScrollView, ScrollViewProps } from "react-native";

type Props = ScrollViewProps;

let KeyboardAwareScrollView: ComponentType<any> | null = null;
if (Platform.OS !== "android") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    KeyboardAwareScrollView = require("react-native-keyboard-controller").KeyboardAwareScrollView;
  } catch {
    KeyboardAwareScrollView = null;
  }
}

export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = "handled",
  ...props
}: Props) {
  if (Platform.OS === "web" || !KeyboardAwareScrollView) {
    return (
      <ScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props}>
        {children}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}
