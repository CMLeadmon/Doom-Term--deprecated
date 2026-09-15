// Text-only rendering for a separately labelled historical capture. React
// escapes markup; this removes terminal controls so captured title/colour/DCS
// traffic cannot appear as visible garbage or influence the live emulator.
// eslint-disable-next-line no-control-regex
const STRING_CONTROL = /\x1b(?:\]|P|X|\^|_)[\s\S]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:.|$)/gs;
// eslint-disable-next-line no-control-regex
const C0 = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function archivePresentationText(data: string): string {
  return data.replace(STRING_CONTROL, '').replace(CSI, '').replace(ESCAPE, '')
    .replace(/\r\n?/g, '\n').replace(C0, '');
}
