import tls from 'node:tls';
import { protocolError, RfbError } from './errors.js';
import { ByteReader } from './reader.js';
/**
 * The byte stream under the protocol: feeds a ByteReader from a Duplex and writes to it, can switch
 * to TLS mid-stream (VeNCrypt) or add a cipher (RSA-AES). Stream errors and the end of the stream
 * end the reader, so the parser's pending read fails with an RfbError.
 */
export class Transport {
    reader = new ByteReader();
    #stream;
    #cipher = null;
    #connected;
    #ended = false;
    /** `connected` false: the stream is still connecting (a failure then is CONNECTION_FAILED). */
    constructor(stream, connected) {
        this.#stream = stream;
        this.#connected = connected;
        this.#attach(stream);
        if (!connected)
            stream.once('connect', () => (this.#connected = true));
    }
    get stream() {
        return this.#stream;
    }
    write(data) {
        if (this.#ended || this.#stream.destroyed || !this.#stream.writable)
            return false;
        return this.#stream.write(this.#cipher ? this.#cipher.encrypt(data) : data);
    }
    /** Ends the stream after pending writes (a graceful close). */
    end() {
        this.#ended = true;
        this.#stream.end();
    }
    destroy() {
        this.#ended = true;
        this.#stream.destroy();
        this.reader.destroy(new RfbError('CONNECTION_CLOSED', 'the connection was closed'));
    }
    /** Switches to TLS over the current stream (the server is waiting for our ClientHello). */
    async startTls(options) {
        if (this.reader.available > 0)
            throw protocolError('the server sent data before the TLS handshake');
        const raw = this.#stream;
        this.#detach(raw);
        const socket = tls.connect({ ...options, socket: raw });
        try {
            await new Promise((resolve, reject) => {
                socket.once('secureConnect', resolve);
                socket.once('error', reject);
                socket.once('close', () => reject(new Error('the connection closed during the TLS handshake')));
            });
        }
        catch (err) {
            socket.destroy();
            raw.destroy();
            const message = err.message;
            throw new RfbError('TLS_FAILED', `the TLS handshake failed (${message}); check the \`tls\` options (ca, servername, rejectUnauthorized)`, { cause: err });
        }
        this.#stream = socket;
        this.#attach(socket);
    }
    /**
     * Encrypts everything from now on (`null`: stops encrypting). Bytes already buffered are
     * ciphertext and are moved through the new cipher.
     */
    setCipher(cipher) {
        this.#cipher = cipher;
        const pending = cipher && this.reader.available > 0 ? this.reader.peek() : null;
        if (cipher && pending) {
            this.reader.consume(pending.length);
            cipher.decrypt(Buffer.from(pending), (plain) => this.reader.push(plain));
        }
    }
    #onData = (chunk) => {
        if (!this.#cipher) {
            this.reader.push(chunk);
            return;
        }
        try {
            this.#cipher.decrypt(chunk, (plain) => this.reader.push(plain));
        }
        catch (err) {
            this.reader.destroy(err instanceof RfbError ? err : protocolError(`decryption failed: ${err.message}`));
            this.#stream.destroy();
        }
    };
    #onError = (err) => {
        const code = err.code ? ` (${err.code})` : '';
        this.reader.destroy(this.#connected
            ? new RfbError('CONNECTION_CLOSED', `the connection broke: ${err.message}${code}`, { cause: err })
            : new RfbError('CONNECTION_FAILED', `can't connect: ${err.message}; is the VNC server running?`, {
                cause: err,
            }));
    };
    #onClose = () => {
        this.reader.destroy(this.#connected
            ? new RfbError('CONNECTION_CLOSED', 'the server closed the connection')
            : new RfbError('CONNECTION_FAILED', "can't connect: the connection closed while connecting"));
    };
    #attach(stream) {
        stream.on('data', this.#onData);
        stream.on('error', this.#onError);
        stream.on('end', this.#onClose);
        stream.on('close', this.#onClose);
    }
    #detach(stream) {
        stream.off('data', this.#onData);
        stream.off('error', this.#onError);
        stream.off('end', this.#onClose);
        stream.off('close', this.#onClose);
    }
}
//# sourceMappingURL=transport.js.map