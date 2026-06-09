import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera,
  useCameraPermission,
  useCameraFormat,
  type CameraDevice,
} from 'react-native-vision-camera';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import * as FileSystem from 'expo-file-system/legacy';
import type { MediaFile } from '@/services/media';

type Props = {
  visible: boolean;
  maxFotos: number;
  initialCount: number;
  onClose: (files: MediaFile[]) => void;
  onPhotoConfirmed?: (file: MediaFile) => void;
};

type Mode = 'camera' | 'confirm';

type ZoomPill = { label: string; targetDeviceKind: 'wide' | 'ultraWide'; zoom: number };

// vision-camera no Android (CameraX) usa zoom = fator de zoom direto, relativo
// ao device atual. zoom=1 é o "neutral" do device (1x na lente wide; 0.5x na
// ultra-wide). Por isso não precisa de mais nenhum hack — só trocar `device`
// já dá o salto entre lentes.
const RAIL_MAX_ZOOM_FACTOR = 5; // x — limite útil da régua (rolagem fina até ~5x)
const FOCUS_MARKER_SIZE = 64;

export function CameraSessionVision({
  visible,
  maxFotos,
  initialCount,
  onClose,
  onPhotoConfirmed,
}: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);

  const [mode, setMode] = useState<Mode>('camera');
  const [count, setCount] = useState(initialCount);
  const [photos, setPhotos] = useState<MediaFile[]>([]);
  const [preview, setPreview] = useState<{ uri: string; file: MediaFile } | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // --- Devices físicos ---
  // Enumeramos uma vez no mount. CameraX expõe um device por lente física na
  // maioria dos celulares modernos (Wide angle + Ultra-wide + Telephoto, se
  // houver). Pegamos o wide pra 1x/2x e o ultra-wide pra 0.5x.
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  useEffect(() => {
    if (!visible) return;
    const list = Camera.getAvailableCameraDevices();
    setDevices(list);
  }, [visible]);

  const wideDevice = useMemo(
    () =>
      devices.find(
        (d) =>
          d.position === 'back' &&
          d.physicalDevices.includes('wide-angle-camera') &&
          !d.physicalDevices.includes('ultra-wide-angle-camera'),
      ) ??
      // Fallback: qualquer back wide (mesmo se vier combinado)
      devices.find(
        (d) => d.position === 'back' && d.physicalDevices.includes('wide-angle-camera'),
      ) ??
      devices.find((d) => d.position === 'back'),
    [devices],
  );
  const ultraWideDevice = useMemo(
    () =>
      devices.find(
        (d) =>
          d.position === 'back' &&
          d.physicalDevices.length === 1 &&
          d.physicalDevices.includes('ultra-wide-angle-camera'),
      ) ??
      // Fallback: qualquer device com ultra-wide entre as físicas
      devices.find(
        (d) => d.position === 'back' && d.physicalDevices.includes('ultra-wide-angle-camera'),
      ),
    [devices],
  );

  // Device atualmente ativo (default = wide). Pills mudam isso.
  const [activeKind, setActiveKind] = useState<'wide' | 'ultraWide'>('wide');
  const activeDevice = activeKind === 'ultraWide' && ultraWideDevice ? ultraWideDevice : wideDevice;

  // Zoom relativo ao device atual (1.0 = neutralZoom do device).
  const [zoom, setZoom] = useState(1);

  // Reset ao abrir
  useEffect(() => {
    if (visible) {
      setMode('camera');
      setCount(initialCount);
      setPhotos([]);
      setPreview(null);
      setTorchOn(false);
      setCapturing(false);
      setActiveKind('wide');
      setZoom(1);
    }
  }, [visible, initialCount]);

  // Pede permissão se ainda não tem
  useEffect(() => {
    if (visible && hasPermission === false) {
      void requestPermission();
    }
  }, [visible, hasPermission, requestPermission]);

  // Formato 4:3 (a foto + preview saem como câmera nativa em modo "Foto")
  const format = useCameraFormat(activeDevice ?? undefined, [
    { photoAspectRatio: 4 / 3 },
    { photoResolution: 'max' },
  ]);

  // Pills disponíveis (0.5x só se tiver ultraWideDevice)
  const zoomPills = useMemo<ZoomPill[]>(() => {
    const pills: ZoomPill[] = [];
    if (ultraWideDevice) pills.push({ label: '0.5x', targetDeviceKind: 'ultraWide', zoom: 1 });
    pills.push({ label: '1x', targetDeviceKind: 'wide', zoom: 1 });
    pills.push({ label: '2x', targetDeviceKind: 'wide', zoom: 2 });
    return pills;
  }, [ultraWideDevice]);

  // Qual pill destacar
  const activePillLabel = useMemo(() => {
    if (activeKind === 'ultraWide') return '0.5x';
    if (zoom >= 1.5) return '2x';
    return '1x';
  }, [activeKind, zoom]);

  const handlePillPress = useCallback(
    (pill: ZoomPill) => {
      if (pill.targetDeviceKind === 'ultraWide' && !ultraWideDevice) return;
      setActiveKind(pill.targetDeviceKind);
      setZoom(pill.zoom);
    },
    [ultraWideDevice],
  );

  // --- Captura ---
  const handleShutter = useCallback(async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: false,
      });
      const filePath = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      const base64 = await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const file: MediaFile = {
        base64,
        mimeType: 'image/jpeg',
        fileName: `photo_${Date.now()}.jpg`,
      };
      setPreview({ uri: filePath, file });
      setMode('confirm');
    } catch {
      Alert.alert('Erro', 'Não foi possível capturar a foto.');
    } finally {
      setCapturing(false);
    }
  }, [capturing]);

  const handleUsePhoto = useCallback(() => {
    if (!preview) return;
    onPhotoConfirmed?.(preview.file);
    const nextPhotos = [...photos, preview.file];
    const nextCount = count + 1;
    setPhotos(nextPhotos);
    setCount(nextCount);
    setPreview(null);
    if (nextCount >= maxFotos) {
      onClose(nextPhotos);
    } else {
      setMode('camera');
    }
  }, [preview, photos, count, maxFotos, onClose, onPhotoConfirmed]);

  const handleRetake = useCallback(() => {
    setPreview(null);
    setMode('camera');
  }, []);

  const handleClose = useCallback(() => {
    onClose(photos);
  }, [onClose, photos]);

  // --- Pinch-to-zoom ---
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const baseZoomAtPinchStart = useRef(1);

  const pinchGesture = useMemo(() => {
    const minZ = activeDevice?.minZoom ?? 1;
    const maxZ = activeDevice?.maxZoom ?? 1;
    return Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        baseZoomAtPinchStart.current = zoomRef.current;
      })
      .onUpdate((e) => {
        const next = Math.max(minZ, Math.min(maxZ, baseZoomAtPinchStart.current * e.scale));
        setZoom(next);
      });
  }, [activeDevice]);

  // --- Tap-to-focus REAL ---
  // vision-camera faz foco no ponto que o usuário tocou (não só visual).
  const [focusMarker, setFocusMarker] = useState<{ x: number; y: number } | null>(null);
  const focusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
    },
    [],
  );

  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .onEnd((e) => {
          setFocusMarker({ x: e.x, y: e.y });
          if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
          focusTimeoutRef.current = setTimeout(() => setFocusMarker(null), 900);
          // Dispara o foco real no ponto (silencioso em erro — devices sem
          // foco programável simplesmente ignoram).
          cameraRef.current?.focus({ x: e.x, y: e.y }).catch(() => {});
        }),
    [],
  );

  const cameraBoxGesture = useMemo(
    () => Gesture.Simultaneous(pinchGesture, tapGesture),
    [pinchGesture, tapGesture],
  );

  // --- Régua de zoom ---
  // Mapeia x da régua → fator de zoom no device atual [minZoom, RAIL_MAX_ZOOM_FACTOR].
  const railPanGesture = useMemo(() => {
    const minZ = activeDevice?.minZoom ?? 1;
    const railMax = Math.min(RAIL_MAX_ZOOM_FACTOR, activeDevice?.maxZoom ?? RAIL_MAX_ZOOM_FACTOR);
    return Gesture.Pan()
      .runOnJS(true)
      .onBegin((e) => {
        const pct = Math.max(0, Math.min(RAIL_WIDTH, e.x)) / RAIL_WIDTH;
        setZoom(minZ + pct * (railMax - minZ));
      })
      .onUpdate((e) => {
        const pct = Math.max(0, Math.min(RAIL_WIDTH, e.x)) / RAIL_WIDTH;
        setZoom(minZ + pct * (railMax - minZ));
      });
  }, [activeDevice]);

  if (!visible) return null;

  if (hasPermission === false) {
    return (
      <Modal visible animationType="slide" statusBarTranslucent transparent={false}>
        <View style={styles.permissionWrap}>
          <Text style={styles.permissionTitle}>Permissão de câmera</Text>
          <Text style={styles.permissionText}>
            Precisamos da câmera pra capturar fotos das visitas.
          </Text>
          <TouchableOpacity style={styles.permissionBtn} onPress={() => void requestPermission()}>
            <Text style={styles.permissionBtnText}>Permitir</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.permissionBtn, styles.cancelBtn]}
            onPress={handleClose}
          >
            <Text style={styles.permissionBtnText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    );
  }

  // Sem device disponível ainda (enquanto enumera ou em devices sem câmera)
  if (!activeDevice) {
    return (
      <Modal visible animationType="slide" statusBarTranslucent transparent={false}>
        <View style={styles.permissionWrap}>
          <ActivityIndicator color="#fff" />
        </View>
      </Modal>
    );
  }

  // Cálculo da posição visual do thumb da régua
  const minZ = activeDevice.minZoom ?? 1;
  const railMax = Math.min(RAIL_MAX_ZOOM_FACTOR, activeDevice.maxZoom ?? RAIL_MAX_ZOOM_FACTOR);
  const railPct = Math.max(0, Math.min(1, (zoom - minZ) / Math.max(0.001, railMax - minZ)));
  const railPos = railPct * RAIL_WIDTH;

  return (
    <Modal visible animationType="slide" statusBarTranslucent transparent={false}>
      <GestureHandlerRootView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.topBtn} onPress={handleClose} hitSlop={8}>
            <Text style={styles.topBtnText}>✕  Encerrar</Text>
          </TouchableOpacity>
          <View style={styles.topRight}>
            {mode === 'camera' && (
              <TouchableOpacity
                style={[styles.torchBtn, torchOn && styles.torchBtnOn]}
                onPress={() => setTorchOn((v) => !v)}
                hitSlop={8}
              >
                <Text style={[styles.torchText, torchOn && styles.torchTextOn]}>⚡  Lanterna</Text>
              </TouchableOpacity>
            )}
            <View style={styles.counter}>
              <Text style={styles.counterText}>
                {count}/{maxFotos} {maxFotos === 1 ? 'foto' : 'fotos'}
              </Text>
            </View>
          </View>
        </View>

        {/* Camera area */}
        <View style={styles.cameraArea}>
          <GestureDetector gesture={cameraBoxGesture}>
            <View style={styles.cameraBox}>
              <Camera
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                device={activeDevice}
                isActive={mode === 'camera'}
                photo
                zoom={zoom}
                torch={torchOn ? 'on' : 'off'}
                format={format ?? undefined}
                resizeMode="cover"
              />
              {mode === 'confirm' && preview && (
                // Backdrop preto opaco: o <Camera> acima continua montado (só
                // inativo) e leva um instante pra apagar o último frame ao vivo.
                // Como a Image abaixo usa `contain` (não preenche a caixa toda),
                // sem esse backdrop o frame residual da câmera vazava nas tarjas
                // e dava a impressão de imagem "espelhada"/duplicada.
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.confirmBackdrop]} />
              )}
              {mode === 'confirm' && preview && (
                // `contain` (não `cover`): a foto capturada pode ser paisagem
                // (4:3) quando o usuário gira o celular, e a caixa do preview é
                // 3:4 retrato. Com `cover` o preview cortava as laterais e dava
                // a impressão de que a foto foi recortada — mas o arquivo salvo
                // é o frame inteiro. `contain` mostra a foto INTEIRA (com tarja
                // preta nas sobras) pra a confirmação bater com o que foi salvo.
                <Image
                  source={{ uri: preview.uri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="contain"
                />
              )}
              {focusMarker && mode === 'camera' && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.focusMarker,
                    {
                      left: focusMarker.x - FOCUS_MARKER_SIZE / 2,
                      top: focusMarker.y - FOCUS_MARKER_SIZE / 2,
                    },
                  ]}
                />
              )}
            </View>
          </GestureDetector>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          {mode === 'camera' ? (
            <>
              <GestureDetector gesture={railPanGesture}>
                <View style={styles.railHit} hitSlop={12}>
                  <View style={styles.railTrack}>
                    <View style={[styles.railFill, { width: railPos }]} />
                    <View style={[styles.railThumb, { left: railPos - RAIL_THUMB / 2 }]} />
                  </View>
                </View>
              </GestureDetector>
              {zoomPills.length > 1 && (
                <View style={styles.pillsRow}>
                  {zoomPills.map((pill) => {
                    const active = pill.label === activePillLabel;
                    return (
                      <TouchableOpacity
                        key={pill.label}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => handlePillPress(pill)}
                        hitSlop={6}
                      >
                        <Text style={[styles.pillText, active && styles.pillTextActive]}>
                          {pill.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              <TouchableOpacity
                style={styles.shutter}
                onPress={handleShutter}
                disabled={capturing}
                activeOpacity={0.7}
              >
                {capturing ? <ActivityIndicator color="#fff" /> : <View style={styles.shutterInner} />}
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.confirmBar}>
              <Text style={styles.confirmTitle}>A foto ficou boa?</Text>
              <View style={styles.confirmRow}>
                <TouchableOpacity
                  style={[styles.confirmBtn, styles.retakeBtn]}
                  onPress={handleRetake}
                >
                  <Text style={styles.confirmBtnText}>↺  Tirar outra</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.confirmBtn, styles.useBtn]}
                  onPress={handleUsePhoto}
                >
                  <Text style={[styles.confirmBtnText, styles.useBtnText]}>✓  Usar foto</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// --- Régua de zoom — mesmas dimensões da versão Expo pra consistência visual.
const RAIL_WIDTH = 220;
const RAIL_HEIGHT = 4;
const RAIL_THUMB = 12;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  header: {
    paddingTop: 40,
    paddingBottom: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBtn: { paddingVertical: 6, paddingRight: 8 },
  topBtnText: { color: '#fff', fontSize: 15, fontWeight: '500' },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  torchBtn: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  torchBtnOn: { backgroundColor: '#FACC15' },
  torchText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  torchTextOn: { color: '#000' },
  counter: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  counterText: { color: '#fff', fontSize: 13, fontWeight: '500' },

  cameraArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraBox: {
    width: '100%',
    aspectRatio: 3 / 4,
    overflow: 'hidden',
    backgroundColor: '#000',
  },

  confirmBackdrop: { backgroundColor: '#000' },

  focusMarker: {
    position: 'absolute',
    width: FOCUS_MARKER_SIZE,
    height: FOCUS_MARKER_SIZE,
    borderWidth: 2,
    borderColor: '#FACC15',
    borderRadius: 6,
    backgroundColor: 'rgba(250,204,21,0.08)',
  },

  footer: {
    paddingBottom: 32,
    paddingTop: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    minHeight: 150,
    justifyContent: 'center',
    gap: 14,
  },

  railHit: {
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railTrack: {
    width: RAIL_WIDTH,
    height: RAIL_HEIGHT,
    borderRadius: RAIL_HEIGHT / 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    position: 'relative',
  },
  railFill: {
    height: RAIL_HEIGHT,
    borderRadius: RAIL_HEIGHT / 2,
    backgroundColor: 'rgba(250,204,21,0.55)',
  },
  railThumb: {
    position: 'absolute',
    top: (RAIL_HEIGHT - RAIL_THUMB) / 2,
    width: RAIL_THUMB,
    height: RAIL_THUMB,
    borderRadius: RAIL_THUMB / 2,
    backgroundColor: '#FACC15',
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.35)',
  },

  pillsRow: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRadius: 22,
  },
  pill: {
    height: 32,
    minWidth: 40,
    paddingHorizontal: 10,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: { backgroundColor: '#FACC15' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  pillTextActive: { color: '#000' },

  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff',
  },

  confirmBar: { width: '100%' },
  confirmTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
  },
  confirmRow: { flexDirection: 'row', gap: 12 },
  confirmBtn: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retakeBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  useBtn: { backgroundColor: '#fff' },
  confirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  useBtnText: { color: '#000' },

  permissionWrap: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  permissionTitle: { color: '#fff', fontSize: 22, fontWeight: '700' },
  permissionText: { color: '#ccc', fontSize: 15, textAlign: 'center', marginBottom: 8 },
  permissionBtn: {
    width: '100%',
    height: 48,
    borderRadius: 8,
    backgroundColor: '#1565C0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: { backgroundColor: 'rgba(255,255,255,0.15)' },
  permissionBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
