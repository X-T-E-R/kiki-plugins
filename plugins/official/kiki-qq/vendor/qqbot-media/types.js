export class ApiError extends Error {
  name = 'ApiError';
  constructor(message, httpStatus, path, bizCode, bizMessage) {
    super(message); Object.assign(this, { httpStatus, path, bizCode, bizMessage });
  }
}
export const MediaFileType = { IMAGE: 1, VIDEO: 2, VOICE: 3, FILE: 4 };
