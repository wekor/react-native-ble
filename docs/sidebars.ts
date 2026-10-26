import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'overview',
    'installation',
    {
      type: 'category',
      label: 'Guides',
      collapsed: false,
      items: ['permissions', 'scanning', 'connecting', 'reading-and-writing', 'listening', 'background', 'l2cap'],
    },
    'api',
    'comparison',
  ],
};

export default sidebars;
