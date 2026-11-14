// One JSON object per line on stdout.
//
// Railway parses this format: `level` sets the colour and can be filtered with
// @level:error, and every other field can be searched with @name:value.
// Everything goes to stdout on purpose, because Railway marks every line
// written to stderr as an error regardless of its level.

export function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, message, ...fields })}\n`);
}
