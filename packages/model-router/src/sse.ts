export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser tolerant to arbitrary TCP chunk splits and CRLF/LF.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const flushEvent = (): SseEvent | null => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return null;
    }
    const evt: SseEvent = {
      event: currentEvent,
      data: dataLines.join('\n'),
    };
    currentEvent = undefined;
    dataLines = [];
    return evt;
  };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line === '') {
          const evt = flushEvent();
          if (evt) yield evt;
          continue;
        }
        if (line.startsWith(':')) continue;

        const colonIdx = line.indexOf(':');
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
        let fieldValue = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);

        if (field === 'event') {
          currentEvent = fieldValue;
        } else if (field === 'data') {
          dataLines.push(fieldValue);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data:')) {
        let fieldValue = line.slice(5);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
        dataLines.push(fieldValue);
      }
    }
    const trailing = flushEvent();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
