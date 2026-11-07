// Encrypted waitlist: the browser encrypts the email with RSA-OAEP (SHA-256) and posts only the
// ciphertext to an unguessable ntfy topic. A private Action appends it to the signup log.
const SPKI =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs+mNwFXq8J0wdqI0N5iAzw554IAKk9mPXxxwcr4AGwiER5x2AJZ45cTBOWCYizrW0dZZM1k9VW0jIzuzU3sRH+hsPxwWbkVLM239hNHUh8j5T35E7HWsrWYiVohUzcJmeSL8kNb0BZcXAT2Ge/zlA1wi1KdfzVOjWIUXxDcww06rIDiQirFKlC+NpWkIwEBmvYak7WP3BX6hb9TX+i51FpoT/IZu0EEbg41T3YcF2+BeSsEi4aU7iDOOMwfq5K41FphsXp7jHdHbUPP7El/4kH/3UIYxDqpaIfhFF2KCLLbg7lpyZ8YVEwmFqGVe6kiKTUudqO6aJmFkhHA0Ug81cwIDAQAB'
const TOPIC = 'https://ntfy.sh/copybook-wl-f28e48dcb0ac6e45f17fb1c0b2e77e83'

export async function joinWaitlist(email: string): Promise<void> {
  const spki = Uint8Array.from(atob(SPKI), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  const buf = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(email)))
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  const res = await fetch(TOPIC, {
    method: 'POST',
    headers: { Title: 'Copybook waitlist', 'Content-Type': 'text/plain' },
    body: btoa(bin),
  })
  if (!res.ok) throw new Error(`waitlist ${res.status}`)
}
