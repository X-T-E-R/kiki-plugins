export class RfbError extends Error {
    code;
    /** The server's own explanation, when it sent one. */
    reason;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'RfbError';
        this.code = code;
        if (options.reason !== undefined)
            this.reason = options.reason;
    }
}
export function protocolError(message) {
    return new RfbError('PROTOCOL_ERROR', message);
}
//# sourceMappingURL=errors.js.map