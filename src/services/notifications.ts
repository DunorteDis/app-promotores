import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type NotificationPermissionResult = {
  granted: boolean;
  token?: string;
  error?: string;
};

export async function registerForPushNotificationsAsync(): Promise<NotificationPermissionResult> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Padrão',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    }

    if (!Device.isDevice) {
      return { granted: false, error: 'Notificações funcionam apenas em dispositivos físicos.' };
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      return { granted: false, error: 'Permissão de notificação negada.' };
    }

    return { granted: true };
  } catch (error) {
    return { granted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Obtém o Expo push token do aparelho (pede permissão se ainda não concedida).
// Exposto pra web via bridge 'notifications.getToken' — é a web quem associa o
// token ao usuário logado enviando pro backend.
export async function getPushTokenAsync(): Promise<{ token: string; platform: string }> {
  const perm = await registerForPushNotificationsAsync();
  if (!perm.granted) {
    throw new Error(perm.error ?? 'Permissão de notificação negada.');
  }

  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
  if (!projectId) {
    throw new Error('EAS projectId ausente na configuração do app.');
  }

  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return { token: data, platform: Platform.OS };
}

export async function scheduleLocalNotification(title: string, body: string, data?: Record<string, unknown>) {
  return Notifications.scheduleNotificationAsync({
    content: { title, body, data: data ?? {} },
    trigger: null,
  });
}
