const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("CreatorOS Render Worker Online");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "CreatorOS Render Worker"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
