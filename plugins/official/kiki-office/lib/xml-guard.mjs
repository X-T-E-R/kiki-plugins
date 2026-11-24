import { OfficeError } from './paths.mjs';

const MAX_XML_DEPTH = 128;
const MAX_XML_NODES = 200_000;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const NAME_CHAR = /^[A-Za-z_:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][A-Za-z0-9_.:-\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]*$/;
const PREDEFINED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

function decodeXmlBytes(bytes, partName) {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    }
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    throw new OfficeError('PACKAGE_INVALID', `Malformed XML encoding in part: ${partName}`, 'Use an uncorrupted Office document.');
  }
}

function isValidXmlCodePoint(cp) {
  return cp === 0x09 || cp === 0x0a || cp === 0x0d
    || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);
}

function decodeEntities(raw, partName) {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;\s&]+);|&/g, (match, ref) => {
    if (!ref) {
      throw new OfficeError('PACKAGE_INVALID', `Malformed XML entity in part: ${partName}`, 'Use an uncorrupted Office document.');
    }
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const digits = hex ? ref.slice(2) : ref.slice(1);
      if (!digits || (hex ? !/^[0-9a-fA-F]+$/ : !/^[0-9]+$/).test(digits)) {
        throw new OfficeError('PACKAGE_INVALID', `Invalid XML character reference in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      const cp = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isSafeInteger(cp) || !isValidXmlCodePoint(cp)) {
        throw new OfficeError('PACKAGE_UNSAFE', `Disallowed XML character reference in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      return String.fromCodePoint(cp);
    }
    const resolved = PREDEFINED_ENTITIES.get(ref);
    if (resolved === undefined) {
      throw new OfficeError('PACKAGE_UNSAFE', `Unsupported XML entity reference &${ref}; in part: ${partName}`, 'Remove custom DTD/entity declarations before opening this document.');
    }
    return resolved;
  });
}

function splitQName(qname, partName) {
  if (!NAME_CHAR.test(qname)) {
    throw new OfficeError('PACKAGE_INVALID', `Invalid XML name "${qname}" in part: ${partName}`, 'Use an uncorrupted Office document.');
  }
  const idx = qname.indexOf(':');
  if (idx < 0) return { prefix: '', local: qname };
  if (idx === 0 || idx === qname.length - 1 || qname.indexOf(':', idx + 1) >= 0) {
    throw new OfficeError('PACKAGE_INVALID', `Invalid qualified XML name "${qname}" in part: ${partName}`, 'Use an uncorrupted Office document.');
  }
  return { prefix: qname.slice(0, idx), local: qname.slice(idx + 1) };
}

export function parseXmlStrict(bytes, partName) {
  const src = decodeXmlBytes(bytes, partName);
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(src)) {
    throw new OfficeError('PACKAGE_INVALID', `Control characters found in XML part: ${partName}`, 'Use an uncorrupted Office document.');
  }

  let i = 0;
  const len = src.length;
  let root = null;
  let nodes = 0;
  let seenXmlDecl = false;
  let seenContent = false;
  const stack = [];
  const nsStack = [{ defaultNs: '', prefixes: new Map([['xml', XML_NS], ['xmlns', XMLNS_NS]]) }];

  const skipWs = () => {
    while (i < len && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n')) i++;
  };

  const readName = () => {
    const start = i;
    while (i < len && !/[\s/>=?<"'!]/.test(src[i])) i++;
    return src.slice(start, i);
  };

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      const trailing = src.slice(i);
      if (trailing.trim()) {
        throw new OfficeError('PACKAGE_INVALID', `Unexpected trailing text in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (stack.length === 0) {
        if (text.trim()) {
          throw new OfficeError('PACKAGE_INVALID', `Unexpected text outside root element in XML part: ${partName}`, 'Use an uncorrupted Office document.');
        }
      } else {
        decodeEntities(text, partName);
      }
    }
    i = lt;

    if (src.startsWith('<!--', i)) {
      seenContent = true;
      const end = src.indexOf('-->', i + 4);
      if (end < 0 || src.slice(i + 4, end).includes('--')) {
        throw new OfficeError('PACKAGE_INVALID', `Malformed XML comment in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      i = end + 3;
      continue;
    }

    if (src.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) {
        throw new OfficeError('PACKAGE_INVALID', `CDATA outside root element in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) {
        throw new OfficeError('PACKAGE_INVALID', `Unclosed CDATA section in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      i = end + 3;
      continue;
    }

    if (src.startsWith('<!', i)) {
      throw new OfficeError('PACKAGE_UNSAFE', `Disallowed XML declaration (DTD/ENTITY) in part: ${partName}`, 'Remove DTD and entity declarations before opening this document.');
    }

    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) {
        throw new OfficeError('PACKAGE_INVALID', `Unclosed XML processing instruction in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      const piBody = src.slice(i + 2, end);
      const target = piBody.split(/\s/, 1)[0] ?? '';
      if (!target || !NAME_CHAR.test(target)) {
        throw new OfficeError('PACKAGE_INVALID', `Malformed XML processing instruction in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      if (target.toLowerCase() === 'xml') {
        if (seenXmlDecl || seenContent || i !== 0 || target !== 'xml') {
          throw new OfficeError('PACKAGE_INVALID', `Misplaced XML declaration in part: ${partName}`, 'Use an uncorrupted Office document.');
        }
        seenXmlDecl = true;
      } else {
        seenContent = true;
        if (target.toLowerCase() === 'xml-stylesheet' || /(?:href\s*=|https?:|file:|\\\\)/i.test(piBody)) {
          throw new OfficeError('PACKAGE_UNSAFE', `Disallowed XML processing instruction <?${target}?> in part: ${partName}`, 'Remove external processing instructions before opening this document.');
        }
      }
      i = end + 2;
      continue;
    }

    if (src.startsWith('</', i)) {
      i += 2;
      const closeName = readName();
      skipWs();
      if (i >= len || src[i] !== '>') {
        throw new OfficeError('PACKAGE_INVALID', `Malformed closing tag in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      i++;
      const top = stack.pop();
      nsStack.pop();
      if (!top || top.qname !== closeName) {
        throw new OfficeError('PACKAGE_INVALID', `Mismatched XML closing tag </${closeName}> in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      continue;
    }

    // Start tag
    seenContent = true;
    if (stack.length === 0 && root !== null) {
      throw new OfficeError('PACKAGE_INVALID', `Multiple root elements in XML part: ${partName}`, 'Use an uncorrupted Office document.');
    }
    i++; // consume '<'
    const qname = readName();
    const { prefix, local } = splitQName(qname, partName);
    const rawAttrs = [];
    const seenRawAttr = new Set();
    let selfClosing = false;

    while (i < len) {
      const beforeWs = i;
      skipWs();
      if (src.startsWith('/>', i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (src[i] === '>') {
        i++;
        break;
      }
      if (i === beforeWs) {
        throw new OfficeError('PACKAGE_INVALID', `Expected whitespace between attributes in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      const attrQName = readName();
      if (!attrQName) {
        throw new OfficeError('PACKAGE_INVALID', `Malformed XML attribute in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      splitQName(attrQName, partName);
      if (seenRawAttr.has(attrQName)) {
        throw new OfficeError('PACKAGE_INVALID', `Duplicate XML attribute "${attrQName}" in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      seenRawAttr.add(attrQName);
      skipWs();
      if (src[i] !== '=') {
        throw new OfficeError('PACKAGE_INVALID', `Expected '=' after attribute "${attrQName}" in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      i++;
      skipWs();
      const quote = src[i];
      if (quote !== '"' && quote !== "'") {
        throw new OfficeError('PACKAGE_INVALID', `Unquoted XML attribute "${attrQName}" in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      i++;
      const closeQuote = src.indexOf(quote, i);
      if (closeQuote < 0) {
        throw new OfficeError('PACKAGE_INVALID', `Unclosed attribute quote on "${attrQName}" in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      const rawVal = src.slice(i, closeQuote);
      if (rawVal.includes('<')) {
        throw new OfficeError('PACKAGE_INVALID', `Illegal '<' in attribute "${attrQName}" in XML part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      rawAttrs.push({ qname: attrQName, value: decodeEntities(rawVal, partName) });
      i = closeQuote + 1;
    }

    const parentScope = nsStack[nsStack.length - 1];
    const scope = { defaultNs: parentScope.defaultNs, prefixes: new Map(parentScope.prefixes) };
    for (const attr of rawAttrs) {
      if (attr.qname === 'xmlns') {
        scope.defaultNs = attr.value;
      } else if (attr.qname.startsWith('xmlns:')) {
        const pfx = attr.qname.slice(6);
        if (!pfx || pfx === 'xml' || pfx === 'xmlns') {
          throw new OfficeError('PACKAGE_INVALID', `Invalid namespace binding "${attr.qname}" in part: ${partName}`, 'Use an uncorrupted Office document.');
        }
        scope.prefixes.set(pfx, attr.value);
      }
    }

    let ns = scope.defaultNs;
    if (prefix) {
      ns = scope.prefixes.get(prefix);
      if (ns === undefined) {
        throw new OfficeError('PACKAGE_INVALID', `Undeclared XML namespace prefix "${prefix}" in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
    }

    const attrs = [];
    const seenExpandedAttr = new Set();
    for (const attr of rawAttrs) {
      if (attr.qname === 'xmlns' || attr.qname.startsWith('xmlns:')) continue;
      const parts = splitQName(attr.qname, partName);
      let attrNs = '';
      if (parts.prefix) {
        attrNs = scope.prefixes.get(parts.prefix);
        if (attrNs === undefined) {
          throw new OfficeError('PACKAGE_INVALID', `Undeclared attribute namespace prefix "${parts.prefix}" in part: ${partName}`, 'Use an uncorrupted Office document.');
        }
      }
      const expandedKey = `${attrNs}\0${parts.local}`;
      if (seenExpandedAttr.has(expandedKey)) {
        throw new OfficeError('PACKAGE_INVALID', `Duplicate namespace-resolved attribute in part: ${partName}`, 'Use an uncorrupted Office document.');
      }
      seenExpandedAttr.add(expandedKey);
      attrs.push({ qname: attr.qname, local: parts.local, ns: attrNs, value: attr.value });
    }

    nodes++;
    if (nodes > MAX_XML_NODES) {
      throw new OfficeError('PACKAGE_LIMIT', `XML node limit exceeded in part: ${partName}`, 'Use a smaller Office document.');
    }

    const node = { qname, local, ns, attrs, children: [] };
    if (stack.length === 0) {
      root = node;
    } else {
      stack[stack.length - 1].children.push(node);
    }

    if (!selfClosing) {
      if (stack.length + 1 > MAX_XML_DEPTH) {
        throw new OfficeError('PACKAGE_LIMIT', `XML nesting depth limit exceeded in part: ${partName}`, 'Use a less deeply nested Office document.');
      }
      stack.push(node);
      nsStack.push(scope);
    }
  }

  if (stack.length > 0 || !root) {
    throw new OfficeError('PACKAGE_INVALID', `Incomplete XML document in part: ${partName}`, 'Use an uncorrupted Office document.');
  }
  return root;
}

export function attrValue(node, localName, ns = '') {
  const found = node.attrs.find((attr) => attr.local === localName && attr.ns === ns);
  return found?.value;
}
