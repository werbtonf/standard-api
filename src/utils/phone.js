/**
 * Normaliza e formata números de telefone (com suporte a números brasileiros e DDI padrão).
 */
export function formatPhoneNumber(input, defaultCountryCode = '55') {
  let clean = String(input || '').trim().replace(/[^0-9]/g, '');
  if (!clean) return clean;
  if (clean.length === 10 || clean.length === 11) {
    clean = defaultCountryCode + clean;
  }
  return clean;
}

/**
 * Garante que a string termine com @s.whatsapp.net se não for grupo.
 */
export function normalizeJid(jidOrNumber) {
  let str = String(jidOrNumber || '').trim();
  if (!str) return str;
  if (str.includes('@')) return str;
  const formatted = formatPhoneNumber(str);
  return `${formatted}@s.whatsapp.net`;
}
