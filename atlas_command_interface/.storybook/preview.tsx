import type { Preview } from "@storybook/react-vite";
import "../src/ui/tokens.css";
import "../src/ui/console.css";
import "../src/storybook/storybook.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "Atlas console",
      values: [{ name: "Atlas console", value: "#070a0f" }]
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    layout: "fullscreen"
  }
};

export default preview;
