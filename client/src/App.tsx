import React from "react";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";

function App() {
  const [token, setToken] = React.useState("");

  return token ? <Dashboard /> : <Login setToken={setToken} />;
}

export default App;
