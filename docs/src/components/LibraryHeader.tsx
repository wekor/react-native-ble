import useBaseUrl from '@docusaurus/useBaseUrl';
import type { ReactNode } from 'react';
import Platforms from './Platforms';

const GITHUB =
  'M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z';

const NPM = 'M2 2h20v20H2V2Zm3.6 3.6v12.8h6.4V8.8h3.2v9.6h3.2V5.6H5.6Z';

const Icon = ({ d }: { d: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15">
    <path fill="currentColor" d={d} />
  </svg>
);

/** The top of the overview, after Expo's library pages: icon, name, summary, platforms and links. */
export default function LibraryHeader({ title, children }: { title: string; children: ReactNode }) {
  const icon = useBaseUrl('/img/logo.svg');
  return (
    <header className="library-header">
      <div className="library-header__title">
        <img className="library-header__icon" src={icon} alt="" />
        <h1>{title}</h1>
      </div>
      {/* A div: MDX already wraps the children in a paragraph, and paragraphs cannot nest. */}
      <div className="library-header__description">{children}</div>
      <Platforms android="7.0+" ios="15.1+" chipsOnly />
      <div className="library-header__links">
        <a href="https://github.com/wekor/react-native-ble">
          <Icon d={GITHUB} />
          GitHub
        </a>
        <a href="https://www.npmjs.com/package/@wekor/react-native-ble">
          <Icon d={NPM} />
          npm
        </a>
      </div>
    </header>
  );
}
