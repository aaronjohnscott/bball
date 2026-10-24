const NUMBERS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];

function say(n: number): string {
  return NUMBERS[n] ?? String(n);
}

let enabled = true;

export function setVoice(on: boolean): void {
  enabled = on;
  if (!on) speechSynthesis?.cancel();
}

/** iOS only speaks after a user gesture; call this from the Start tap. */
export function unlockVoice(): void {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

/** "Make. Seven of twelve." */
export function announce(result: 'make' | 'miss', makes: number, shots: number, prefix = ''): void {
  if (!enabled || !('speechSynthesis' in window)) return;
  const word = result === 'make' ? 'Make' : 'Miss';
  const u = new SpeechSynthesisUtterance(`${prefix}${word}. ${say(makes)} of ${say(shots)}.`);
  u.rate = 1.1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
