import queue from '@phosphor-icons/core/assets/light/queue-light.svg?raw';
import edit from '@phosphor-icons/core/assets/light/pencil-simple-light.svg?raw';
import trash from '@phosphor-icons/core/assets/light/trash-light.svg?raw';
import more from '@phosphor-icons/core/assets/light/dots-three-light.svg?raw';
import close from '@phosphor-icons/core/assets/light/x-light.svg?raw';
import pause from '@phosphor-icons/core/assets/light/pause-light.svg?raw';
import play from '@phosphor-icons/core/assets/light/play-light.svg?raw';
import chevron from '@phosphor-icons/core/assets/light/caret-down-light.svg?raw';
import undo from '@phosphor-icons/core/assets/light/arrow-counter-clockwise-light.svg?raw';
import up from '@phosphor-icons/core/assets/light/arrow-up-light.svg?raw';
import down from '@phosphor-icons/core/assets/light/arrow-down-light.svg?raw';
import add from '@phosphor-icons/core/assets/light/list-plus-light.svg?raw';

const icons: Record<string, string> = { queue, edit, trash, more, close, pause, play, chevron, undo, up, down, add };
export const icon = (name: string) => (icons[name] ?? queue).replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
