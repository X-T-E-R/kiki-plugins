const SECRET_MARK = '[redacted]';

export function secretValues(credentials) {
  const found = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.length >= 4) found.push(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const item of Object.values(value)) visit(item);
  };
  visit(credentials);
  return found;
}

export function redactText(value, secrets) {
  let text = typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '');
  const needles = [...new Set(secrets.filter((item) => typeof item === 'string' && item.length >= 4))].sort((a, b) => b.length - a.length);
  for (const secret of needles) text = text.split(secret).join(SECRET_MARK);
  return text;
}

export function redactJson(value, secrets) {
  return redactText(JSON.stringify(value), secrets);
}
