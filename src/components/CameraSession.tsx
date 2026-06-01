import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import type { MediaFile } from '@/services/media';

type Props = {
  visible: boolean;
  maxFotos: number;
  initialCount: number;
  onClose: (files: MediaFile[]) => void;
};

type Mode = 'camera' | 'confirm';

// iOS expõe lentes físicas via getAvailableLensesAsync / onAvailableLensesChanged.
// Android não — `expo-camera` só dá acesso ao "back camera" lógico (com zoom digital).
const IOS_LENS_ULTRA_WIDE = 'builtInUltraWideCamera';
const IOS_LENS_WIDE = 'builtInWideAngleCamera';

type ZoomPill = { label: string; zoom: number; lens?: string };

/**
 * Tela nativa de câmera multi-shot. Layout estilo "câmera Foto 4:3" do sistema:
 *   header (encerrar/lanterna/contador) → viewfinder 3:4 retrato centralizado
 *   → footer com pills de zoom + obturador. O viewfinder NÃO ocupa a tela
 *   inteira pra não esticar o feed do sensor (o que dava sensação de zoom).
 *
 * Multi-shot: tirar → "A foto ficou boa?" → "Usar foto" / "Tirar outra"
 *   → volta pro viewfinder, sem fechar a tela. Encerra ao bater o limite
 *   ou ao tocar em × Encerrar.
 */
export function CameraSession({ visible, maxFotos, initialCount, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [mode, setMode] = useState<Mode>('camera');
  const [count, setCount] = useState(initialCount);
  const [photos, setPhotos] = useState<MediaFile[]>([]);
  const [preview, setPreview] = useState<{ uri: string; file: MediaFile } | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // Zoom (0–1, percentual do zoom DIGITAL — funciona em ambos os SOs).
  const [zoom, setZoom] = useState(0);
  // iOS only: lente atualmente selecionada (wide / ultraWide / telephoto).
  const [selectedLens, setSelectedLens] = useState<string | undefined>(undefined);
  // iOS only: lentes detectadas pelo onAvailableLensesChanged.
  const [availableLenses, setAvailableLenses] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      setMode('camera');
      setCount(initialCount);
      setPhotos([]);
      setPreview(null);
      setTorchOn(false);
      setCapturing(false);
      setZoom(0);
      setSelectedLens(undefined);
      setAvailableLenses([]);
    }
  }, [visible, initialCount]);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  // Pills de zoom — sempre mostra 1x e 2x (zoom digital). Adiciona 0.5x quando
  // a câmera atual EXPÕE a ultra-wide (só iOS — Android não tem essa API).
  const zoomPills = useMemo<ZoomPill[]>(() => {
    const pills: ZoomPill[] = [];
    const hasUltraWide = Platform.OS === 'ios' && availableLenses.includes(IOS_LENS_ULTRA_WIDE);
    if (hasUltraWide) pills.push({ label: '0.5x', zoom: 0, lens: IOS_LENS_ULTRA_WIDE });
    pills.push({ label: '1x', zoom: 0, lens: Platform.OS === 'ios' ? IOS_LENS_WIDE : undefined });
    pills.push({ label: '2x', zoom: 0.5, lens: Platform.OS === 'ios' ? IOS_LENS_WIDE : undefined });
    return pills;
  }, [availableLenses]);

  // Qual pill está "ativa" agora (pra destacar visualmente).
  const activePillLabel = useMemo(() => {
    if (Platform.OS === 'ios' && selectedLens === IOS_LENS_ULTRA_WIDE) return '0.5x';
    if (zoom >= 0.4) return '2x';
    return '1x';
  }, [zoom, selectedLens]);

  const handleShutter = useCallback(async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        base64: true,
        exif: false,
      });
      if (!photo) {
        setCapturing(false);
        return;
      }
      const file: MediaFile = {
        base64: photo.base64 ?? '',
        mimeType: 'image/jpeg',
        fileName: `photo_${Date.now()}.jpg`,
      };
      setPreview({ uri: photo.uri, file });
      setMode('confirm');
    } catch {
      Alert.alert('Erro', 'Não foi possível capturar a foto.');
    } finally {
      setCapturing(false);
    }
  }, [capturing]);

  const handleUsePhoto = useCallback(() => {
    if (!preview) return;
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
  }, [preview, photos, count, maxFotos, onClose]);

  const handleRetake = useCallback(() => {
    setPreview(null);
    setMode('camera');
  }, []);

  const handleClose = useCallback(() => {
    onClose(photos);
  }, [onClose, photos]);

  const handlePillPress = useCallback((pill: ZoomPill) => {
    setZoom(pill.zoom);
    if (Platform.OS === 'ios') setSelectedLens(pill.lens);
  }, []);

  // --- Pinch to zoom (dois dedos) ---
  // Mantém uma ref espelhada do zoom atual pra ler dentro do callback do gesto
  // sem disparar re-render. baseZoomAtPinchStart guarda o ponto de partida do
  // gesto pra calcular o delta. Sensibilidade 0.5 tornou o pinch confortável
  // em testes — pode tunar.
  const zoomRef = useRef(0);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const baseZoomAtPinchStart = useRef(0);

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          baseZoomAtPinchStart.current = zoomRef.current;
        })
        .onUpdate((e) => {
          const next = Math.max(0, Math.min(1, baseZoomAtPinchStart.current + (e.scale - 1) * 0.5));
          setZoom(next);
        }),
    [],
  );

  if (!visible) return null;

  if (permission && !permission.granted) {
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
                <Text style={[styles.torchText, torchOn && styles.torchTextOn]}>
                  {torchOn ? '⚡  Lanterna' : '⚡  Lanterna'}
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.counter}>
              <Text style={styles.counterText}>
                {count}/{maxFotos} {maxFotos === 1 ? 'foto' : 'fotos'}
              </Text>
            </View>
          </View>
        </View>

        {/* Camera area — viewfinder 3:4 portrait centralizado.
            Pinch (dois dedos) ajusta o zoom dentro da janela. */}
        <View style={styles.cameraArea}>
          <GestureDetector gesture={pinchGesture}>
            <View style={styles.cameraBox}>
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing="back"
                ratio="4:3"
                zoom={zoom}
                enableTorch={torchOn}
                {...(Platform.OS === 'ios' && selectedLens ? { selectedLens } : {})}
                onAvailableLensesChanged={({ lenses }: { lenses: string[] }) => {
                  setAvailableLenses(lenses);
                }}
              />
              {mode === 'confirm' && preview && (
                <Image
                  source={{ uri: preview.uri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                />
              )}
            </View>
          </GestureDetector>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          {mode === 'camera' ? (
            <>
              {/* Pills de zoom */}
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
                {capturing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <View style={styles.shutterInner} />
                )}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  // Header
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
  torchBtnOn: { backgroundColor: '#FACC15' /* amber-400 */ },
  torchText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  torchTextOn: { color: '#000' },
  counter: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  counterText: { color: '#fff', fontSize: 13, fontWeight: '500' },

  // Camera area: viewfinder 3:4 portrait centralizado
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

  // Footer
  footer: {
    paddingBottom: 32,
    paddingTop: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    minHeight: 150,
    justifyContent: 'center',
    gap: 14,
  },

  // Zoom pills
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

  // Obturador
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

  // Confirm
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

  // Permissão
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
