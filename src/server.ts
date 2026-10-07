import app from "./app.js";
import { config } from "./config.js";

app.listen(config.PORT, () => {
  console.log(`Server running at http://localhost:${config.PORT}`);
});