"use client";

import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(124,58,237,0.18),_transparent_34%),linear-gradient(180deg,#050816_0%,#09111f_50%,#050816_100%)] px-4 py-12 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-6xl items-center justify-center">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-4 shadow-2xl shadow-violet-950/20 backdrop-blur-xl">
          <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl="/" />
        </div>
      </div>
    </main>
  );
}