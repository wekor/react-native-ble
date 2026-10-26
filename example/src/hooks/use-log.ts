import { useCallback, useState } from 'react';

export type LogLine = {
  id: number;
  time: string;
  text: string;
  tone?: 'error' | 'rx' | 'tx';
};

export type Log = (text: string, tone?: LogLine['tone']) => void;

let nextLine = 1;

/** A capped, newest-first log. */
export const useLog = (limit = 200) => {
  const [lines, setLines] = useState<LogLine[]>([]);
  const add: Log = useCallback(
    (text, tone) => {
      const time = new Date().toLocaleTimeString([], { hour12: false });
      setLines((previous) =>
        [{ id: nextLine++, time, text, tone }, ...previous].slice(0, limit)
      );
    },
    [limit]
  );
  const clear = useCallback(() => setLines([]), []);
  return { lines, add, clear };
};
