import { extensionClient } from './client.ts';
import { QueueController } from './controller.ts';

const start = () => new QueueController(document, extensionClient()).start();
if (document.documentElement) start();
else document.addEventListener('DOMContentLoaded', start, { once: true });
