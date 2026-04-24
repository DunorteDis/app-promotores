import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';

import { registerForPushNotificationsAsync } from '@/services/notifications';
import { requestLocationPermission } from '@/services/location';

export default function RootLayout() {
  useEffect(() => {
    void registerForPushNotificationsAsync();
    void requestLocationPermission();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
      </Stack>
    </SafeAreaProvider>
  );
}
