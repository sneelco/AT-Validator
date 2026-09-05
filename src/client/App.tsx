import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import { useSession } from "./auth/client";
import { SignIn } from "./auth/SignIn";
import { Header } from "./components/Header";
import { ConflictBanner } from "./components/ConflictBanner";
import { UpdateToast } from "./components/UpdateToast";
import { AccountPage } from "./pages/Account";
import { sync } from "./store/sync";
import { ATValidatorFeature } from "./features/atv/ATValidatorFeature"; // ★ app feature

/** Wires the auth session into the sync engine. Renders nothing. */
function SyncBridge() {
  const { data: session, isPending } = useSession();
  useEffect(() => {
    sync.start();
    return () => sync.stop();
  }, []);
  useEffect(() => {
    if (!isPending) sync.setSignedIn(Boolean(session));
  }, [session, isPending]);
  return null;
}

function Home() {
  return (
    <main>
      <ATValidatorFeature />
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SyncBridge />
      <UpdateToast />
      <ConflictBanner />
      <Header />
      <div className="mx-auto max-w-5xl px-4 pb-16">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="*" element={<p className="py-10 text-center text-muted-foreground">Not found.</p>} />
        </Routes>
      </div>
      <Toaster position="bottom-center" richColors closeButton />
    </BrowserRouter>
  );
}
