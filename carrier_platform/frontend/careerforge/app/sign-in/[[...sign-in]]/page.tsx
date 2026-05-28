"use client";

import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(87,214,255,0.16),_transparent_34%),linear-gradient(180deg,#050816_0%,#09111f_50%,#050816_100%)] px-4 py-12 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-6xl items-center justify-center">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-4 shadow-2xl shadow-cyan-950/20 backdrop-blur-xl">
          <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl="/" />
        </div>
      </div>
    </main>
  );
}