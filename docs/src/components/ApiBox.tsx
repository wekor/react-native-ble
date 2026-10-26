import Heading from '@theme/Heading';
import type { ReactNode } from 'react';
import Platforms from './Platforms';

type Support = boolean | string;

/**
 * One API, as Expo's reference draws it: a card with the signature in monospace and the platforms it runs
 * on, then its description, parameters and return value.
 */
export default function ApiBox({
  id,
  name,
  android,
  ios,
  children,
}: {
  id: string;
  name: string;
  android?: Support;
  ios?: Support;
  children: ReactNode;
}) {
  return (
    <section className="api-box">
      <div className="api-box__header">
        <Heading as="h3" id={id}>
          {name}
        </Heading>
        <Platforms android={android} ios={ios} chipsOnly />
      </div>
      <div className="api-box__body">{children}</div>
    </section>
  );
}
