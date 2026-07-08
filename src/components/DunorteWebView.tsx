import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import type { LocationSubscription } from 'expo-location';

import { getBatterySnapshot, subscribeBattery } from '@/services/battery';
import {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  INJECTED_JS,
} from '@/services/bridge';
import { captureImage, openFile, pickImages, type MediaFile } from '@/services/media';
import { cancelAppUpdate, downloadAndInstallApk } from '@/services/appUpdate';
import { getCurrentLocation, requestLocationPermission, watchLocation } from '@/services/location';
import { getNetworkSnapshot, subscribeNetwork } from '@/services/network';
import {
  getPushTokenAsync,
  registerForPushNotificationsAsync,
  scheduleLocalNotification,
} from '@/services/notifications';

import { CameraSession } from './CameraSession';
import { LoadingOverlay } from './LoadingOverlay';
import { OfflineBanner } from './OfflineBanner';

// Build de desenvolvimento (expo run:android): abre o Vite local via adb
// reverse (localhost no celular = PC). Release (__DEV__ false) segue produção.
const TARGET_URL = __DEV__ ? 'http://localhost:8080' : 'https://vexo.dunorte.com.br';

type Props = {
  onOnlineChange?: (online: boolean) => void;
};

const LOADING_TIMEOUT_MS = 8000;

export function DunorteWebView({ onOnlineChange }: Props) {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);

  const batteryUnsubRef = useRef<null | (() => void)>(null);
  const networkUnsubRef = useRef<null | (() => void)>(null);
  const locationSubRef = useRef<LocationSubscription | null>(null);
  const firstLoadDoneRef = useRef(false);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sessão de câmera nativa multi-shot (ponte: media.captureSession).
  // `streamPhotos`: quando o caller envia true, emitimos um evento `media.photo`
  // por foto confirmada e retornamos array vazio no resolve final — assim o
  // caller pode iniciar upload em paralelo e não duplica processamento.
  const [cameraSession, setCameraSession] = useState<{
    visible: boolean;
    maxFotos: number;
    initialCount: number;
    streamPhotos: boolean;
  }>({ visible: false, maxFotos: 1, initialCount: 0, streamPhotos: false });
  const sessionResolveRef = useRef<((files: MediaFile[]) => void) | null>(null);

  const handleSessionClose = useCallback((files: MediaFile[]) => {
    sessionResolveRef.current?.(files);
    sessionResolveRef.current = null;
    setCameraSession((prev) => ({ ...prev, visible: false }));
  }, []);

  const clearLoadingTimeout = useCallback(() => {
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, []);

  const showLoading = useCallback(() => {
    setLoading(true);
    clearLoadingTimeout();
    loadingTimeoutRef.current = setTimeout(() => {
      setLoading(false);
      loadingTimeoutRef.current = null;
    }, LOADING_TIMEOUT_MS);
  }, [clearLoadingTimeout]);

  const hideLoading = useCallback(() => {
    clearLoadingTimeout();
    setLoading(false);
  }, [clearLoadingTimeout]);

  const sendResponse = useCallback((response: BridgeResponse) => {
    const script = `window.DunorteNative && window.DunorteNative.__handleMessage(${JSON.stringify(
      JSON.stringify(response),
    )}); true;`;
    webRef.current?.injectJavaScript(script);
  }, []);

  const sendEvent = useCallback((event: BridgeEvent) => {
    const script = `window.DunorteNative && window.DunorteNative.__handleMessage(${JSON.stringify(
      JSON.stringify(event),
    )}); true;`;
    webRef.current?.injectJavaScript(script);
  }, []);

  const handleRequest = useCallback(
    async (req: BridgeRequest) => {
      try {
        switch (req.type) {
          case 'battery.get': {
            const snapshot = await getBatterySnapshot();
            sendResponse({ id: req.id, ok: true, data: snapshot });
            break;
          }
          case 'battery.subscribe': {
            batteryUnsubRef.current?.();
            batteryUnsubRef.current = subscribeBattery((snapshot) =>
              sendEvent({ event: 'battery.update', data: snapshot }),
            );
            const snapshot = await getBatterySnapshot();
            sendResponse({ id: req.id, ok: true, data: snapshot });
            break;
          }
          case 'battery.unsubscribe': {
            batteryUnsubRef.current?.();
            batteryUnsubRef.current = null;
            sendResponse({ id: req.id, ok: true, data: { stopped: true } });
            break;
          }
          case 'location.get': {
            const result = await getCurrentLocation();
            if (result.ok) sendResponse({ id: req.id, ok: true, data: result.location });
            else sendResponse({ id: req.id, ok: false, error: result.error });
            break;
          }
          case 'location.watch': {
            const granted = await requestLocationPermission();
            if (!granted) {
              sendResponse({ id: req.id, ok: false, error: 'Permissão de localização negada.' });
              break;
            }
            if (locationSubRef.current) {
              locationSubRef.current.remove();
              locationSubRef.current = null;
            }
            locationSubRef.current = await watchLocation(
              (payload) => sendEvent({ event: 'location.update', data: payload }),
              (error) => sendEvent({ event: 'location.update', data: { error } }),
            );
            sendResponse({ id: req.id, ok: true, data: { watching: true } });
            break;
          }
          case 'location.unwatch': {
            locationSubRef.current?.remove();
            locationSubRef.current = null;
            sendResponse({ id: req.id, ok: true, data: { stopped: true } });
            break;
          }
          case 'network.get': {
            const snapshot = await getNetworkSnapshot();
            sendResponse({ id: req.id, ok: true, data: snapshot });
            break;
          }
          case 'network.subscribe': {
            networkUnsubRef.current?.();
            networkUnsubRef.current = subscribeNetwork((snapshot) =>
              sendEvent({ event: 'network.update', data: snapshot }),
            );
            const snapshot = await getNetworkSnapshot();
            sendResponse({ id: req.id, ok: true, data: snapshot });
            break;
          }
          case 'network.unsubscribe': {
            networkUnsubRef.current?.();
            networkUnsubRef.current = null;
            sendResponse({ id: req.id, ok: true, data: { stopped: true } });
            break;
          }
          case 'notifications.requestPermission': {
            const result = await registerForPushNotificationsAsync();
            sendResponse({
              id: req.id,
              ok: result.granted,
              data: result,
              error: result.granted ? undefined : result.error,
            });
            break;
          }
          case 'notifications.getToken': {
            const result = await getPushTokenAsync();
            sendResponse({ id: req.id, ok: true, data: result });
            break;
          }
          case 'notifications.schedule': {
            const payload = (req.payload ?? {}) as {
              title?: string;
              body?: string;
              data?: Record<string, unknown>;
            };
            const notificationId = await scheduleLocalNotification(
              payload.title ?? 'Dunorte Promotores',
              payload.body ?? '',
              payload.data,
            );
            sendResponse({ id: req.id, ok: true, data: { notificationId } });
            break;
          }
          case 'media.capture': {
            const captureResult = await captureImage();
            sendResponse({
              id: req.id,
              ok: true,
              data: { files: captureResult.ok ? captureResult.files : [] },
            });
            break;
          }
          case 'media.pick': {
            const multiple = Boolean(req.payload?.multiple);
            const pickResult = await pickImages(multiple);
            sendResponse({
              id: req.id,
              ok: true,
              data: { files: pickResult.ok ? pickResult.files : [] },
            });
            break;
          }
          case 'media.captureSession': {
            const payload = (req.payload ?? {}) as {
              maxFotos?: number;
              initialCount?: number;
              streamPhotos?: boolean;
            };
            const maxFotos = Math.max(1, Math.min(50, Number(payload.maxFotos) || 5));
            const initialCount = Math.max(0, Number(payload.initialCount) || 0);
            const streamPhotos = Boolean(payload.streamPhotos);

            // Se já tem uma sessão pendente (não deveria), encerra a antiga com array vazio
            // pra não deixar o caller pendurado.
            sessionResolveRef.current?.([]);

            const files = await new Promise<MediaFile[]>((resolve) => {
              sessionResolveRef.current = resolve;
              setCameraSession({ visible: true, maxFotos, initialCount, streamPhotos });
            });
            // Em modo stream, as fotos já foram entregues uma a uma via evento
            // 'media.photo' — devolve array vazio pra evitar processamento dobrado.
            sendResponse({
              id: req.id,
              ok: true,
              data: { files: streamPhotos ? [] : files },
            });
            break;
          }
          case 'media.openFile': {
            const payload = (req.payload ?? {}) as {
              base64?: string;
              mimeType?: string;
              fileName?: string;
            };
            const result = await openFile({
              base64: payload.base64 ?? '',
              mimeType: payload.mimeType,
              fileName: payload.fileName,
            });
            if (result.ok) {
              sendResponse({ id: req.id, ok: true, data: { opened: true } });
            } else {
              sendResponse({ id: req.id, ok: false, error: result.error });
            }
            break;
          }
          case 'app.downloadUpdate': {
            const payload = (req.payload ?? {}) as { url?: string };
            const url = String(payload.url ?? '').trim();
            if (!url) {
              sendResponse({ id: req.id, ok: false, error: 'URL da atualização ausente.' });
              break;
            }
            const result = await downloadAndInstallApk(url, (progress) =>
              sendEvent({ event: 'app.downloadProgress', data: progress }),
            );
            if (result.ok) {
              sendResponse({ id: req.id, ok: true, data: { installed: true } });
            } else {
              sendResponse({ id: req.id, ok: false, error: result.error });
            }
            break;
          }
          case 'app.cancelUpdate': {
            cancelAppUpdate();
            sendResponse({ id: req.id, ok: true, data: { cancelled: true } });
            break;
          }
          default:
            sendResponse({ id: req.id, ok: false, error: `Tipo desconhecido: ${req.type}` });
        }
      } catch (error) {
        sendResponse({
          id: req.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [sendEvent, sendResponse],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const parsed = JSON.parse(event.nativeEvent.data);
        if (parsed && typeof parsed.id === 'string' && typeof parsed.type === 'string') {
          void handleRequest(parsed as BridgeRequest);
        }
      } catch {
        // mensagens não-JSON são ignoradas
      }
    },
    [handleRequest],
  );

  useEffect(() => {
    const sub = subscribeNetwork((snapshot) => {
      const isOnline = snapshot.isConnected && snapshot.isInternetReachable !== false;
      setOnline(isOnline);
      onOnlineChange?.(isOnline);
      sendEvent({ event: 'network.update', data: snapshot });
    });

    return () => sub();
  }, [onOnlineChange, sendEvent]);

  useEffect(() => {
    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      sendEvent({ event: 'notification.received', data: notification });
    });
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      sendEvent({ event: 'notification.response', data: response });
    });
    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [sendEvent]);

  useEffect(() => {
    const onBack = () => {
      if (canGoBack) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [canGoBack]);

  useEffect(() => {
    return () => {
      batteryUnsubRef.current?.();
      networkUnsubRef.current?.();
      locationSubRef.current?.remove();
      clearLoadingTimeout();
    };
  }, [clearLoadingTimeout]);

  return (
    <View style={styles.container}>
      <OfflineBanner visible={!online} />
      <WebView
        ref={webRef}
        source={{ uri: TARGET_URL }}
        style={styles.webview}
        originWhitelist={['https://*', 'http://*', 'about:*']}
        injectedJavaScriptBeforeContentLoaded={INJECTED_JS}
        injectedJavaScript={INJECTED_JS}
        onMessage={onMessage}
        onLoadStart={() => {
          if (!firstLoadDoneRef.current) showLoading();
        }}
        onLoadEnd={() => {
          firstLoadDoneRef.current = true;
          hideLoading();
        }}
        onLoadProgress={({ nativeEvent }) => {
          if (nativeEvent.progress >= 0.7) hideLoading();
        }}
        onNavigationStateChange={(state) => setCanGoBack(state.canGoBack)}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          hideLoading();
          Alert.alert('Erro ao carregar', nativeEvent.description || 'Falha na página.');
        }}
        onHttpError={() => hideLoading()}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        geolocationEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
      />
      <LoadingOverlay visible={loading} />
      <CameraSession
        visible={cameraSession.visible}
        maxFotos={cameraSession.maxFotos}
        initialCount={cameraSession.initialCount}
        onClose={handleSessionClose}
        onPhotoConfirmed={
          cameraSession.streamPhotos
            ? (file) => sendEvent({ event: 'media.photo', data: file })
            : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  webview: { flex: 1 },
});
