import { security } from '../constants.js';
const names = Object.fromEntries(Object.entries(security).map(([name, n]) => [n, name]));
Object.assign(names, { 0: 'Invalid', 13: 'RA2r', 20: 'SASL', 22: 'xvp', 133: 'RA2r_256' });
/** A security type's name for messages, e.g. `VNC (2)`. */
export function securityName(type) {
    const name = names[type] ?? (type >= 31 && type <= 36 ? 'Apple' : undefined);
    return name ? `${name} (${type})` : `type ${type}`;
}
//# sourceMappingURL=types.js.map