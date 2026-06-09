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
  // Disparado quando o usuário confirma cada foto ("Usar foto"). Permite o
  // caller começar o upload imediatamente em vez de esperar o `onClose` final.
  onPhotoConfirmed?: (file: MediaFile) => void;
};

type Mode = 'camera' | 'confirm';

// expo-camera no iOS retorna `localizedName` do AVCaptureDevice (ex.:
// "Back Camera", "Back Ultra Wide Camera", "Back Telephoto Camera"),
// não os constants tipo `builtInWideAngleCamera`. A gente classifica por
// substring em runtime — funciona em PT/EN e nas variações de iOS.
type LensKind = 'wide' | 'ultraWide' | 'telephoto';

// iPhones modernos expõem TANTO lentes físicas (Back Camera, Back Ultra Wide
// Camera, Back Telephoto Camera) QUANTO lentes virtuais que fundem múltiplos
// sensores (Back Dual Camera, Back Dual Wide Camera, Back Triple Camera).
// As virtuais não respeitam `zoom=0` como "1x exato" — elas fundem sensores e
// o framing fica levemente deslocado. Por isso preferimos lentes físicas.
function isVirtualLens(name: string): boolean {
  return /\b(dual|triple|fusion)\b/i.test(name);
}

function classifyLens(name: string): LensKind | null {
  const lower = name.toLowerCase();
  if (lower.includes('ultra')) return 'ultraWide';
  if (lower.includes('tele')) return 'telephoto';
  if (lower.includes('wide') || lower.includes('back camera')) return 'wide';
  return null;
}

type ZoomPill = { label: string; zoom: number; lensKind?: LensKind };

// Régua de zoom — dimensões em px. Largura calibrada pra caber confortável no
// footer (~70% de uma tela 360dp) e dar precisão suficiente no arrasto.
const RAIL_WIDTH = 220;
const RAIL_HEIGHT = 4;
const RAIL_THUMB = 12;

// expo-camera trata `zoom={0..1}` como percentual do MÁXIMO do device, que em
// celular moderno é 10x-25x. Daí zoom=0.5 vira tipo 5x-12x ("parece 10x"),
// não 2x. As constantes abaixo recalibram pro nosso uso (promotor tirando
// foto de gôndola — raramente precisa passar de ~3-4x).
//
// Valores calibrados empiricamente: em devices testados, zoom abaixo de ~0.09
// é imperceptível (parece 1x). Por isso ZOOM_2X precisa ficar bem acima desse
// limiar pra "2x" ser visivelmente diferente de "1x".
const ZOOM_2X = 0.25;         // ≈2x perceptual em devices com max 10-15x
const RAIL_MAX_ZOOM = 0.5;    // ≈5x — limite útil da régua (dead zone vira ~18%)
const FOCUS_MARKER_SIZE = 64; // px — quadrado amarelo de feedback do tap-to-focus

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
export function CameraSessionExpo({ visible, maxFotos, initialCount, onClose, onPhotoConfirmed }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [mode, setMode] = useState<Mode>('camera');
  const [count, setCount] = useState(initialCount);
  const [photos, setPhotos] = useState<MediaFile[]>([]);
  const [preview, setPreview] = useState<{ uri: string; file: MediaFile } | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // iOS: força `pictureSize` 4:3 pra o preset da sessão ser .photo (4:3) e o
  // preview enquadrar igual à câmera nativa em modo 4:3 (não 16:9). O prop
  // `ratio` é Android-only — no iOS precisa ser via pictureSize.
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);

  // Zoom (0–1, percentual do zoom DIGITAL — funciona em ambos os SOs).
  const [zoom, setZoom] = useState(0);
  // iOS only: lente atualmente selecionada (nome do AVCaptureDevice).
  const [selectedLens, setSelectedLens] = useState<string | undefined>(undefined);
  // iOS only: mapa "tipo de lente → nome real reportado pelo SO".
  // Resolvido via classifyLens(name) quando onAvailableLensesChanged dispara.
  const [lensMap, setLensMap] = useState<Partial<Record<LensKind, string>>>({});

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
      setLensMap({});
      setPictureSize(undefined);
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
    if (Platform.OS === 'ios' && lensMap.ultraWide) {
      pills.push({ label: '0.5x', zoom: 0, lensKind: 'ultraWide' });
    }
    pills.push({ label: '1x', zoom: 0, lensKind: 'wide' });
    pills.push({ label: '2x', zoom: ZOOM_2X, lensKind: 'wide' });
    return pills;
  }, [lensMap.ultraWide]);

  // Qual pill está "ativa" agora (pra destacar visualmente).
  const activePillLabel = useMemo(() => {
    if (Platform.OS === 'ios' && selectedLens && selectedLens === lensMap.ultraWide) return '0.5x';
    if (zoom >= ZOOM_2X * 0.6) return '2x'; // ~ ponto médio entre 1x e 2x
    return '1x';
  }, [zoom, selectedLens, lensMap.ultraWide]);

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
    // Dispara IMEDIATAMENTE pra o caller começar o upload em paralelo enquanto
    // o usuário tira a próxima foto (corta o delay no final da sessão).
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

  const handlePillPress = useCallback(
    (pill: ZoomPill) => {
      setZoom(pill.zoom);
      if (Platform.OS === 'ios' && pill.lensKind) {
        const lensName = lensMap[pill.lensKind];
        if (lensName) setSelectedLens(lensName);
      }
    },
    [lensMap],
  );

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

  // --- Tap-to-focus ---
  // expo-camera v17 não expõe API pra setar ponto de foco específico
  // (`pointOfInterest`). Com `autofocus="on"` já temos foco contínuo, e o
  // próprio ato de tocar/mexer o enquadramento força um re-foco. Aqui
  // adicionamos só o feedback visual (quadrado amarelo onde o usuário tocou)
  // pra a UX ficar igual a câmera nativa.
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
        }),
    [],
  );

  // Pinch (2 dedos) e Tap (1 dedo) podem rolar ao mesmo tempo sem conflito.
  const cameraBoxGesture = useMemo(
    () => Gesture.Simultaneous(pinchGesture, tapGesture),
    [pinchGesture, tapGesture],
  );

  // --- Régua de zoom (Pan horizontal) ---
  // Mapeia x → zoom 0..RAIL_MAX_ZOOM (faixa útil, ~1x-3.5x). Pinch pode ir
  // além; thumb da régua só cápeia visualmente no fim.
  const railPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onBegin((e) => {
          const x = Math.max(0, Math.min(RAIL_WIDTH, e.x));
          setZoom((x / RAIL_WIDTH) * RAIL_MAX_ZOOM);
        })
        .onUpdate((e) => {
          const x = Math.max(0, Math.min(RAIL_WIDTH, e.x));
          setZoom((x / RAIL_WIDTH) * RAIL_MAX_ZOOM);
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
            Pinch (dois dedos) ajusta o zoom; tap (um dedo) mostra o marker
            de foco e ajuda o autofocus contínuo a re-engajar. */}
        <View style={styles.cameraArea}>
          <GestureDetector gesture={cameraBoxGesture}>
            <View style={styles.cameraBox}>
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing="back"
                ratio="4:3"
                zoom={zoom}
                autofocus="on"
                enableTorch={torchOn}
                {...(Platform.OS === 'ios' && selectedLens ? { selectedLens } : {})}
                {...(Platform.OS === 'ios' && pictureSize ? { pictureSize } : {})}
                onAvailableLensesChanged={({ lenses }: { lenses: string[] }) => {
                  if (Platform.OS !== 'ios') return;
                  const next: Partial<Record<LensKind, string>> = {};
                  // Pass 1: SÓ lentes físicas — virtuais (Dual/Triple/Fusion)
                  // ficam por último porque dão framing levemente deslocado em 1x.
                  for (const name of lenses) {
                    if (isVirtualLens(name)) continue;
                    const kind = classifyLens(name);
                    if (kind && !next[kind]) next[kind] = name;
                  }
                  // Pass 2: preenche o que ficou faltando com virtuais.
                  for (const name of lenses) {
                    const kind = classifyLens(name);
                    if (kind && !next[kind]) next[kind] = name;
                  }
                  // Fallback final: se não achou nenhuma "wide", usa a primeira não-ultra.
                  if (!next.wide) {
                    next.wide = lenses.find((n) => !n.toLowerCase().includes('ultra')) ?? lenses[0];
                  }
                  setLensMap(next);
                  // Trava a wide física como padrão. A troca de lente acontece
                  // atrás do overlay preto (previewReady=false até onCameraReady
                  // + delay), então o usuário não vê o flash do iOS default.
                  if (!selectedLens && next.wide) {
                    setSelectedLens(next.wide);
                  }
                }}
                onCameraReady={async () => {
                  // iOS: consulta os pictureSizes disponíveis e seta um 4:3
                  // maior. Isso muda o preset da sessão pra .photo (4:3) e o
                  // preview reconfigura pra enquadrar igual à câmera nativa
                  // em 4:3 (não 16:9). Best-effort: se falhar, segue com o
                  // preset default do expo-camera.
                  if (Platform.OS === 'ios' && !pictureSize) {
                    try {
                      const sizes = await cameraRef.current?.getAvailablePictureSizesAsync?.();
                      if (sizes && sizes.length > 0) {
                        const fourThree = sizes
                          .map((s) => {
                            const m = s.match(/^(\d+)x(\d+)$/);
                            if (!m) return null;
                            const w = parseInt(m[1], 10);
                            const h = parseInt(m[2], 10);
                            return { s, w, ratio: w / h };
                          })
                          .filter(
                            (x): x is { s: string; w: number; ratio: number } =>
                              x !== null && Math.abs(x.ratio - 4 / 3) < 0.02,
                          )
                          .sort((a, b) => b.w - a.w);
                        if (fourThree.length > 0) {
                          setPictureSize(fourThree[0].s);
                        }
                      }
                    } catch {
                      // ignora
                    }
                  }
                }}
              />
              {mode === 'confirm' && preview && (
                // Backdrop preto opaco: o CameraView acima continua ativo no
                // modo confirmação. Como a Image abaixo usa `contain` (não
                // preenche a caixa toda), sem esse backdrop o feed ao vivo da
                // câmera vazaria nas tarjas e daria a impressão de imagem
                // "espelhada"/duplicada.
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
              {/* Marker de foco — aparece onde o usuário tocou e some em 900ms */}
              {focusMarker && mode === 'camera' && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.focusMarker,
                    { left: focusMarker.x - FOCUS_MARKER_SIZE / 2, top: focusMarker.y - FOCUS_MARKER_SIZE / 2 },
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
              {/* Régua de zoom discreta — track fininho com thumb arrastável.
                  Atualiza com pinch e pills. Cápeia o thumb no fim da régua
                  quando zoom ultrapassa RAIL_MAX_ZOOM (pinch indo além). */}
              <GestureDetector gesture={railPanGesture}>
                <View style={styles.railHit} hitSlop={12}>
                  <View style={styles.railTrack}>
                    {(() => {
                      const railPos = Math.min(1, zoom / RAIL_MAX_ZOOM) * RAIL_WIDTH;
                      return (
                        <>
                          <View style={[styles.railFill, { width: railPos }]} />
                          <View style={[styles.railThumb, { left: railPos - RAIL_THUMB / 2 }]} />
                        </>
                      );
                    })()}
                  </View>
                </View>
              </GestureDetector>
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

  confirmBackdrop: { backgroundColor: '#000' },

  // Tap-to-focus marker — quadrado amarelo translúcido com borda
  focusMarker: {
    position: 'absolute',
    width: FOCUS_MARKER_SIZE,
    height: FOCUS_MARKER_SIZE,
    borderWidth: 2,
    borderColor: '#FACC15',
    borderRadius: 6,
    backgroundColor: 'rgba(250,204,21,0.08)',
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

  // Régua de zoom
  railHit: {
    paddingVertical: 10, // hit area maior pra arrastar sem precisar de mira
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
    backgroundColor: 'rgba(250,204,21,0.55)', // âmbar suave, discreto
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
