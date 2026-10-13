import { isChunkLoadError, retryImport } from '../chunk-retry';

const chunkError = () => Object.assign(new Error('Loading chunk 883 failed.'), { name: 'ChunkLoadError' });

describe('lazy-with-retry', () => {
    it('recognises chunk loading failures only', () => {
        expect(isChunkLoadError(chunkError())).toBe(true);
        expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x.js'))).toBe(true);
        expect(isChunkLoadError(new Error('boom'))).toBe(false);
        expect(isChunkLoadError(undefined)).toBe(false);
    });

    it('retries a refused chunk and then succeeds', async () => {
        const factory = jest.fn().mockRejectedValueOnce(chunkError()).mockResolvedValue({ default: 'ok' });
        await expect(retryImport(factory, 2, 1)).resolves.toEqual({ default: 'ok' });
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('gives up after the retries and throws the chunk error', async () => {
        const factory = jest.fn().mockRejectedValue(chunkError());
        await expect(retryImport(factory, 2, 1)).rejects.toMatchObject({ name: 'ChunkLoadError' });
        expect(factory).toHaveBeenCalledTimes(3);
    });

    it('does not retry other errors', async () => {
        const factory = jest.fn().mockRejectedValue(new Error('syntax'));
        await expect(retryImport(factory, 2, 1)).rejects.toThrow('syntax');
        expect(factory).toHaveBeenCalledTimes(1);
    });
});
