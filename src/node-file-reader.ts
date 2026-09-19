// GLTFExporter uses FileReader for Blob conversion. Node supplies Blob but not FileReader.
// Install once, synchronously: exports can run concurrently without replacing each other's shim.
export function ensureFileReader(): void {
  if (typeof globalThis.FileReader !== 'undefined') return;
  class BlobReader {
    result: ArrayBuffer | string | null = null;
    error: unknown = null;
    onload: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void { void this.read(blob, false); }
    readAsDataURL(blob: Blob): void { void this.read(blob, true); }
    private async read(blob: Blob, dataURL: boolean): Promise<void> {
      try {
        const bytes = await blob.arrayBuffer();
        this.result = dataURL ? `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}` : bytes;
        this.onload?.();
      } catch (error) { this.error = error; this.onerror?.(); }
      finally { this.onloadend?.(); }
    }
  }
  Object.defineProperty(globalThis, 'FileReader', { value: BlobReader, configurable: true, writable: true });
}
