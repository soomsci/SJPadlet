export async function compressClassroomImage(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPG, PNG, WebP 이미지를 선택해주세요. 문서와 동영상은 참고 링크로 공유할 수 있어요.');
  if (file.size > 20 * 1024 ** 2) throw new Error('원본 이미지는 20MB 이하로 선택해주세요.');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('이미지 해상도가 너무 큽니다. 크기를 줄여주세요.');
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이미지를 압축하지 못했습니다. 다른 브라우저로 시도해주세요.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('이미지를 압축하지 못했습니다.')), 'image/jpeg', 0.8));
    if (blob.size > 1024 ** 2) throw new Error('압축 후에도 1MB를 초과합니다. 이미지 크기를 줄여주세요.');
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally { bitmap.close(); }
}
