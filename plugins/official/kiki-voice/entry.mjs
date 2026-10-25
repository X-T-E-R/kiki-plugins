import { speak, voice } from './lib/definitions.mjs';
import { execute, speakText, manageVoice } from './lib/voice.mjs';

export function register(api) {
  api.registerTool(speak, (input, context) => execute(speakText, input, context));
  api.registerTool(voice, (input, context) => execute(manageVoice, input, context));
}
