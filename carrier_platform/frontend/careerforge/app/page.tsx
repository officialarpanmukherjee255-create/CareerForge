"use client";
import { useState, useEffect, useCallback } from "react";
import { FileText, User, Award, Briefcase } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Header } from "@/components/ui/header-2";
import { SplineScene } from "@/components/ui/splite";
import { Spotlight } from "@/components/ui/spotlight";
import { Card } from "@/components/ui/card";
import { ButtonColorful } from "@/components/ui/button-colorful";
import { ShaderAnimation } from "@/components/ui/shader-animation";
import RadialOrbitalTimeline from "@/components/ui/radial-orbital-timeline";
import { Pricing } from "@/components/ui/single-pricing-card-1";
import { Footer } from "@/components/footer";
import { Preloader } from "@/components/ui/preloader";

const timelineData = [
  {
    id: 1,
    title: "Resume Builder",
    date: "AI Powered",
    content: "Build ATS-optimized resumes with AI assistance. Voice-based resume creation and LaTeX templates for professional formatting.",
    category: "Core",
    icon: FileText,
    relatedIds: [2, 3],
    status: "completed" as const,
    energy: 100,
  },
  {
    id: 2,
    title: "Resume Analyzer",
    date: "Smart Analysis",
    content: "Get ATS scores, missing skill recommendations, and improvement suggestions. One-click job-fit resume generation.",
    category: "Analysis",
    icon: Award,
    relatedIds: [1, 3, 4],
    status: "completed" as const,
    energy: 95,
  },
  {
    id: 3,
    title: "Cover Letter Gen",
    date: "AI Generated",
    content: "Generate personalized, professionally formatted cover letters tailored to each job description instantly.",
    category: "Writing",
    icon: FileText,
    relatedIds: [2, 4],
    status: "completed" as const,
    energy: 90,
  },
  {
    id: 4,
    title: "Mock Interviews",
    date: "Real-Time AI",
    content: "Simulate real interviews with voice AI. Choose HR, Technical, Behavioral, or Case Study rounds with shadow mode learning.",
    category: "Preparation",
    icon: User,
    relatedIds: [3, 5],
    status: "in-progress" as const,
    energy: 75,
  },
  {
    id: 5,
    title: "Job Discovery",
    date: "Aggregated",
    content: "Unified job dashboard aggregating listings from LinkedIn, Indeed, Naukri, and Glassdoor with advanced filtering.",
    category: "Jobs",
    icon: Briefcase,
    relatedIds: [4, 6],
    status: "in-progress" as const,
    energy: 65,
  },
  {
    id: 6,
    title: "Leaderboards",
    date: "Gamified",
    content: "Compete with peers on domain-specific leaderboards for resume scores and interview performance. Track your progress.",
    category: "Gamification",
    icon: Award,
    relatedIds: [5],
    status: "pending" as const,
    energy: 40,
  },
];

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [splineReady, setSplineReady] = useState(false);
  const [animDone, setAnimDone] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem("cf_preloader_shown")) {
      setLoading(false);
      return;
    }
    const maxTimeout = setTimeout(() => {
      sessionStorage.setItem("cf_preloader_shown", "1");
      setLoading(false);
    }, 12000);
    return () => clearTimeout(maxTimeout);
  }, []);

  useEffect(() => {
    if (!loading) return;
    if (splineReady && animDone) {
      const grace = setTimeout(() => {
        sessionStorage.setItem("cf_preloader_shown", "1");
        setLoading(false);
      }, 400);
      return () => clearTimeout(grace);
    }
  }, [splineReady, animDone, loading]);
    return (
      <AnimatePresence mode="wait">
        {loading ? (
          <Preloader key="preloader" duration={6562} onComplete={() => setAnimDone(true)} />
        ) : (
          <motion.main
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: "easeInOut" }}
            className="min-h-screen bg-black overflow-x-hidden"
          >
      {/* Section 1: Header */}
      <Header />

      {/* Section 2: Hero with Spline 3D */}
      <section className="relative min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-6xl mx-4 h-[600px] bg-black/[0.96] relative overflow-hidden border-white/10">
          <Spotlight className="-top-40 left-0 md:left-60 md:-top-20" fill="white" />
          <div className="flex h-full flex-col md:flex-row">
            <div className="flex-1 p-8 md:p-12 relative z-10 flex flex-col justify-center">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-sm font-mono text-white/60">AI-Powered Career Platform</span>
              </div>
              <h1 className="text-4xl md:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-b from-neutral-50 to-neutral-400 leading-tight pb-6">
                <span>CareerForge</span>
              </h1>
              <p className="mt-4 text-neutral-300 max-w-lg text-sm md:text-base">
                An intelligent AI-powered career development ecosystem combining resume building, ATS optimization,
                interview preparation, cover letter generation, and job discovery into one seamless platform.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="/resume-builder/">
                  <ButtonColorful label="Start Building Your Career" />
                </a>
              </div>
            </div>
            <div className="flex-1 relative min-h-[300px] md:min-h-full">
              <SplineScene
                scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode"
                className="w-full h-full"
                onLoad={() => setSplineReady(true)}
              />
            </div>
          </div>
        </Card>
      </section>

      {/* Section 4: Features / Radial Orbital Timeline */}
      <section id="features" className="relative">
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-0 text-center pointer-events-none pb-8">
          <div className="inline-block rounded-lg border border-white/10 bg-black/60 backdrop-blur-sm px-4 py-1 font-mono text-sm text-white/80">
            Platform Features
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-white mt-4">
            Everything You Need to Land Your Dream Job
          </h2>
          <p className="text-white/50 text-sm mt-2 max-w-xl mx-auto">
            Click any node to explore features. Connected nodes show related tools.
          </p>
        </div>
        <div className="pt-16 md:pt-24">
          <RadialOrbitalTimeline timelineData={timelineData} />
        </div>
      </section>

      {/* Section 5: Shader Animation Visual Section */}
      <section className="relative h-[500px] overflow-hidden">
        <ShaderAnimation />
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="text-center px-4"
          >
            <h2 className="text-4xl md:text-6xl font-bold text-white mb-4">
              AI-Powered Career Tools
            </h2>
            <p className="text-neutral-400 max-w-2xl mx-auto text-sm md:text-base">
              From voice-based resume creation to AI mock interviews with real-time voice interaction — 
              CareerForge combines every tool you need into one intelligent ecosystem.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Section 6: Pricing */}
      <Pricing />

      {/* Section 7: CTA Section */}
      <section className="relative overflow-hidden py-24 bg-black">
        <div className="mx-auto w-full max-w-4xl px-4 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            viewport={{ once: true }}
            className="space-y-6"
          >
            <h2 className="text-3xl md:text-5xl font-bold text-white">
              Ready to Transform Your Career?
            </h2>
            <p className="text-white/60 max-w-xl mx-auto text-sm md:text-base">
              Join thousands of professionals who have accelerated their job search with AI-powered tools.
            </p>
            <div className="flex justify-center">
              <a href="/resume-builder/">
                <ButtonColorful label="Get Started Free →" className="h-12 px-8 text-base" />
              </a>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Section 8: Footer */}
      <Footer />
    </motion.main>
      )}
    </AnimatePresence>
  );
}
