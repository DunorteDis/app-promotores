import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

export type MediaFile = {
  base64: string;
  mimeType: string;
  fileName: string;
};

export type MediaPickResult =
  | { ok: true; files: MediaFile[] }
  | { ok: false; error: string };

export async function captureImage(): Promise<MediaPickResult> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Permissão necessária',
      'Permita o acesso à câmera nas configurações do dispositivo.',
    );
    return { ok: false, error: 'Permissão de câmera negada.' };
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.7,
    base64: true,
    exif: false,
  });

  if (result.canceled) return { ok: true, files: [] };

  return {
    ok: true,
    files: result.assets.map((asset) => ({
      base64: asset.base64 ?? '',
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileName: asset.fileName ?? `photo_${Date.now()}.jpg`,
    })),
  };
}

export async function pickImages(multiple: boolean): Promise<MediaPickResult> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Permissão necessária',
      'Permita o acesso à galeria nas configurações do dispositivo.',
    );
    return { ok: false, error: 'Permissão de galeria negada.' };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: multiple,
    quality: 0.7,
    base64: true,
    exif: false,
  });

  if (result.canceled) return { ok: true, files: [] };

  return {
    ok: true,
    files: result.assets.map((asset) => ({
      base64: asset.base64 ?? '',
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileName: asset.fileName ?? `image_${Date.now()}.jpg`,
    })),
  };
}
