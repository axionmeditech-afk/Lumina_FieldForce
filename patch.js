const fs = require('fs');
const path = "app/(tabs)/attendance.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Update submitAttendance signature
content = content.replace(
  /const submitAttendance = useCallback\(\s*async \(\s*type: "checkin" \| "checkout"\s*\) => {/,
  `const submitAttendance = useCallback(
    async (type: "checkin" | "checkout", options?: { isAuto?: boolean, silent?: boolean }) => {`
);

// 2. Set action loading safely
content = content.replace(
  /setActionLoading\(true\);/,
  `if (!options?.silent) setActionLoading(true);`
);

// 3. Auto checkout logic variables
content = content.replace(
  /const biometricRequired = true;/,
  `const isAuto = options?.isAuto === true;
        const biometricRequired = !isAuto;`
);

// 4. Mute alert for location
content = content.replace(
  /if \(!preCaptureEvidence\) \{\s*Alert\.alert\("Location Unavailable", "Unable to fetch live GPS location\. Please try again\."\);\s*return;\s*\}/,
  `if (!preCaptureEvidence) {
          if (!options?.silent) Alert.alert("Location Unavailable", "Unable to fetch live GPS location. Please try again.");
          return;
        }`
);

// 5. Mute alert for attendance failed & haptics at the end
content = content.replace(
  /void Haptics\.notificationAsync\(Haptics\.NotificationFeedbackType\.Success\)\.catch\(\(\) => \{\s*\/\/ ignore haptics runtime failures\s*\}\);\s*animateSuccess\(\);\s*\} catch \(error\) \{\s*Alert\.alert\("Attendance Failed", error instanceof Error \? error\.message : "Unknown error"\);\s*\} finally \{\s*setActionLoading\(false\);\s*\}/g,
  `if (!options?.silent) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          animateSuccess();
        }
      } catch (error) {
        if (!options?.silent) Alert.alert("Attendance Failed", error instanceof Error ? error.message : "Unknown error");
      } finally {
        if (!options?.silent) setActionLoading(false);
      }`
);

// 6. Add auto-checkout trigger to handleLocationUpdate
const insertionPoint = `setGpsLoading(false);
      setLocationReady(true);`;
const autoCheckoutTrigger = `

      // AUTO CHECKOUT: if checked in, but GPS is confirmed >500m away
      if (checkedInState && !nextEvaluation.inside && !nextEvaluation.signalWeak) {
        if (nextEvaluation.nearestDistanceMeters > 500) {
          void submitAttendance("checkout", { isAuto: true, silent: true });
        }
      }
`;
content = content.replace(insertionPoint, insertionPoint + autoCheckoutTrigger);

fs.writeFileSync(path, content, "utf8");
console.log("Patched attendance.tsx successfully");
