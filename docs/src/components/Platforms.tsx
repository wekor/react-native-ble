type Support = boolean | string;

const APPLE =
  'M18.71,19.5C17.88,20.74 17,21.95 15.66,21.97C14.32,22 13.89,21.18 12.37,21.18C10.84,21.18 10.37,21.95 9.1,22C7.79,22.05 6.8,20.68 5.96,19.47C4.25,17 2.94,12.45 4.7,9.39C5.57,7.87 7.13,6.91 8.82,6.88C10.1,6.86 11.32,7.75 12.11,7.75C12.89,7.75 14.37,6.68 15.92,6.84C16.57,6.87 18.39,7.1 19.56,8.82C19.47,8.88 17.39,10.1 17.41,12.63C17.44,15.65 20.06,16.66 20.09,16.67C20.06,16.74 19.67,18.11 18.71,19.5M13,3.5C13.73,2.67 14.94,2.04 15.94,2C16.07,3.17 15.6,4.35 14.9,5.19C14.21,6.04 13.07,6.7 11.95,6.61C11.8,5.46 12.36,4.26 13,3.5Z';

const ANDROID =
  'M17.6,9.48L19.44,6.3C19.6,5.99 19.48,5.61 19.18,5.45C18.89,5.3 18.53,5.39 18.35,5.67L16.47,8.91C13.61,7.7 10.39,7.7 7.53,8.91L5.65,5.67C5.46,5.38 5.07,5.29 4.78,5.47C4.5,5.65 4.41,6.01 4.56,6.3L6.4,9.48C3.3,11.25 1.28,14.44 1,18H23C22.72,14.44 20.7,11.25 17.6,9.48M7,15.25C6.31,15.25 5.75,14.69 5.75,14C5.75,13.31 6.31,12.75 7,12.75C7.69,12.75 8.25,13.31 8.25,14C8.25,14.69 7.69,15.25 7,15.25M17,15.25C16.31,15.25 15.75,14.69 15.75,14C15.75,13.31 16.31,12.75 17,12.75C17.69,12.75 18.25,13.31 18.25,14C18.25,14.69 17.69,15.25 17,15.25Z';

const Chip = ({ platform, version }: { platform: 'android' | 'ios'; version?: string }) => (
  <span className={`platform platform-${platform}`}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14">
      <path fill="currentColor" d={platform === 'ios' ? APPLE : ANDROID} />
    </svg>
    {platform === 'ios' ? 'iOS' : 'Android'}
    {version ? ` ${version}` : ''}
  </span>
);

/**
 * Platform chips, as Expo's docs draw them: "Only for: iOS" when one platform has it, or both platforms with
 * their minimum versions. `chipsOnly` drops the "Only for:" label, for API box headers that list every platform.
 */
export default function Platforms({ android, ios, chipsOnly }: { android?: Support; ios?: Support; chipsOnly?: boolean }) {
  const only = !chipsOnly && Boolean(android) !== Boolean(ios);
  return (
    <span className="platforms">
      {only && <span className="platforms-label">Only for:</span>}
      {android && <Chip platform="android" version={typeof android === 'string' ? android : undefined} />}
      {ios && <Chip platform="ios" version={typeof ios === 'string' ? ios : undefined} />}
    </span>
  );
}
