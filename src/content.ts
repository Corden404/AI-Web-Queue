import { extensionClient } from './client.ts';
import { QueueController } from './controller.ts';
import { NamingController } from './naming/controller.ts';

const start = () => {
  new QueueController(document, extensionClient()).start();
  new NamingController(document).start();
};
if (document.documentElement) start();
else document.addEventListener('DOMContentLoaded', start, { once: true });
