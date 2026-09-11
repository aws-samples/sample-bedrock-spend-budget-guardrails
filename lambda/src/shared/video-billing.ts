/** Metadata only; never retain a generation prompt or media body. */
export interface VideoBilling {
  resolution?: 'HD' | 'Standard';
  billedSeconds?: number;
}

export interface VideoLog {
  modelId?: string;
  status?: string;
  errorCode?: string;
  error?: unknown;
  input?: { inputBodyJson?: { resolution?: string; duration?: string } };
  output?: {
    outputVideoDurationSeconds?: number;
    outputVideoWidth?: number;
    outputVideoHeight?: number;
    outputVideoFramesPerSecond?: number;
  };
}

/**
 * Ray v2 bills the requested 5s/9s clip and resolution, not MP4 duration.
 * Metadata-only logs omit the request. The exact 1024-square, 24fps, 4.75s
 * signature below was matched to HD 5-second CUR quantities in every hour
 * containing 26 completed jobs. Do not generalize it to arbitrary dimensions
 * or round every provider's media duration up.
 */
export const videoBillingOf = (log: VideoLog): VideoBilling | undefined => {
  if (!/(?:^|\/)luma\.ray-v2:0$/.test(log.modelId ?? '')) return undefined;
  if (log.error || log.errorCode || log.status?.toLowerCase() !== 'completed') return {};
  const input = log.input?.inputBodyJson;
  const resolution = input?.resolution === '720p' ? 'HD'
    : input?.resolution === '540p' ? 'Standard' : undefined;
  const billedSeconds = input?.duration === '5s' ? 5 : input?.duration === '9s' ? 9 : undefined;
  if ((input?.resolution !== undefined && !resolution) || (input?.duration !== undefined && !billedSeconds)) {
    return { resolution, billedSeconds };
  }
  if (resolution && billedSeconds) return { resolution, billedSeconds };
  const out = log.output;
  if (out?.outputVideoWidth === 1024 && out.outputVideoHeight === 1024
    && out.outputVideoFramesPerSecond === 24 && out.outputVideoDurationSeconds === 4.75) {
    return { resolution: resolution ?? 'HD', billedSeconds: billedSeconds ?? 5 };
  }
  return { resolution, billedSeconds };
};
