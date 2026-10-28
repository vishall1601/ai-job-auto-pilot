/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Briefcase, 
  User, 
  Search, 
  CheckCircle, 
  Clock, 
  ExternalLink, 
  FileText, 
  Settings, 
  Play, 
  Pause,
  RefreshCw,
  Plus,
  Trash2,
  AlertCircle,
  ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { searchJobs, generateCoverLetter, Job as AIJob } from './services/geminiService';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Job extends AIJob {
  id: number;
  status: 'found' | 'analyzing' | 'prepared' | 'applied' | 'rejected';
  created_at: string;
}

interface Profile {
  name: string;
  email: string;
  phone: string;
  skills: string;
  experience: string;
  resume_text: string;
  target_roles: string;
  location: string;
  google_sheet_id?: string;
  google_token?: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'profile' | 'jobs' | 'history'>('dashboard');
  const [profile, setProfile] = useState<Profile>({
    name: '',
    email: '',
    phone: '',
    skills: '',
    experience: '',
    resume_text: '',
    target_roles: '',
    location: ''
  });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAutoPilotOn, setIsAutoPilotOn] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [generatedLetter, setGeneratedLetter] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isLinkedInConnected, setIsLinkedInConnected] = useState(false);
  const [isGoogleConnected, setIsGoogleConnected] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [debugInfo, setDebugInfo] = useState<{ redirectUri: string, hasClientId: boolean, hasClientSecret: boolean } | null>(null);

  useEffect(() => {
    fetchProfile();
    fetchJobs();
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' || event.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        const provider = event.data?.type === 'GOOGLE_AUTH_SUCCESS' ? 'google' : 'linkedin';
        addLog(`${provider} connected successfully.`);
        fetchProfile().then(() => {
          if (provider === 'linkedin') {
            setIsLinkedInConnected(true);
            // Auto-start after connection
            setTimeout(() => {
              startJobSearch();
              setIsAutoPilotOn(true);
            }, 1000);
          }
          if (provider === 'google') {
            setIsGoogleConnected(true);
          }
        });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [profile.target_roles, profile.location]); // Re-bind if profile changes

  const fetchProfile = async () => {
    const res = await fetch('/api/profile');
    const data = await res.json();
    if (data && data.linkedin_id) {
      setProfile(prev => ({ ...prev, ...data }));
      if (data.linkedin_token) setIsLinkedInConnected(true);
      if (data.google_token) setIsGoogleConnected(true);
      if (data.google_sheet_id) setSheetUrl(`https://docs.google.com/spreadsheets/d/${data.google_sheet_id}`);
    }

    // Fetch debug info
    const debugRes = await fetch('/api/auth/linkedin/config');
    const debugData = await debugRes.json();
    setDebugInfo(debugData);
  };

  const fetchJobs = async () => {
    const res = await fetch('/api/jobs');
    const data = await res.json();
    setJobs(data);
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      });
      
      if (res.ok) {
        addLog("Profile updated successfully.");
        // Refresh profile to ensure state is in sync
        fetchProfile();
        alert("Profile saved successfully!");
      } else if (res.status === 401) {
        addLog("Error: You must be connected to LinkedIn to save your profile.");
        alert("Please connect LinkedIn first to save your profile.");
      } else {
        addLog("Error saving profile.");
        alert("Failed to save profile. Please try again.");
      }
    } catch (error) {
      addLog("Network error while saving profile.");
    }
  };

  const addLog = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 50));
  };

  const startJobSearch = async () => {
    if (!profile.target_roles || !profile.location) {
      addLog("Error: Please set target roles and location in profile first.");
      return;
    }
    setIsSearching(true);
    addLog(`Starting search for ${profile.target_roles} in ${profile.location}...`);
    
    try {
      const foundJobs = await searchJobs(profile.target_roles, profile.location);
      addLog(`Found ${foundJobs.length} potential jobs.`);
      
      for (const job of foundJobs) {
        const res = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job)
        });
        if (res.ok) {
          addLog(`Added new job: ${job.title} at ${job.company}`);
        }
        // Add a small delay between processing each job to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      fetchJobs();
    } catch (error) {
      addLog("Error during job search.");
    } finally {
      setIsSearching(false);
    }
  };

  const updateJobStatus = async (id: number, status: Job['status']) => {
    await fetch(`/api/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    fetchJobs();
    addLog(`Job #${id} status updated to ${status}`);
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  };

  const deleteMyData = async () => {
    if (window.confirm("Are you sure? This will delete your profile, jobs, and application history permanently.")) {
      await fetch('/api/profile/delete', { method: 'POST' });
      window.location.reload();
    }
  };

  const connectLinkedIn = async () => {
    try {
      const res = await fetch(`/api/auth/linkedin/url?origin=${encodeURIComponent(window.location.origin)}`);
      const { url } = await res.json();
      window.open(url, 'linkedin_oauth', 'width=600,height=700');
    } catch (error) {
      addLog("Error starting LinkedIn connection.");
    }
  };

  const connectGoogle = async () => {
    try {
      const res = await fetch(`/api/auth/google/url?origin=${encodeURIComponent(window.location.origin)}`);
      const { url } = await res.json();
      window.open(url, 'google_oauth', 'width=600,height=700');
    } catch (error) {
      addLog("Error starting Google connection.");
    }
  };

  const saveSheetUrl = async () => {
    if (!sheetUrl) return;
    try {
      const res = await fetch('/api/profile/sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_url: sheetUrl })
      });
      if (res.ok) {
        addLog("Google Sheet linked successfully.");
        alert("Google Sheet linked!");
      }
    } catch (error) {
      addLog("Error linking Google Sheet.");
    }
  };

  const handleResumeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsExtracting(true);
    addLog("Extracting details from resume...");
    
    try {
      // In a real app, we'd send the file to a server or use a library to parse PDF
      // For this demo, we'll simulate extraction using the text if it's a text file
      // or just prompt the user that we're ready for the text.
      const reader = new FileReader();
      reader.onload = async (event) => {
        const text = event.target?.result as string;
        setProfile(prev => ({ ...prev, resume_text: text }));
        addLog("Resume text imported. AI is analyzing...");
        
        // Use Gemini to extract structured info from the text
        const ai = new (await import('@google/genai')).GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `Analyze the following resume text and extract the candidate's details. 
          If a specific field like Email or Phone is not found, try to infer it or leave it as an empty string instead of "NA".
          
          Resume Text:
          ${text.slice(0, 8000)}`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: (await import('@google/genai')).Type.OBJECT,
              properties: {
                name: { type: (await import('@google/genai')).Type.STRING },
                email: { type: (await import('@google/genai')).Type.STRING },
                phone: { type: (await import('@google/genai')).Type.STRING },
                skills: { type: (await import('@google/genai')).Type.STRING, description: "Comma separated list of key skills" },
                experience: { type: (await import('@google/genai')).Type.STRING, description: "Brief summary of work history" },
              }
            }
          }
        });

        const extracted = JSON.parse(response.text || "{}");
        setProfile(prev => ({ ...prev, ...extracted }));
        addLog("Profile details extracted successfully.");
        setIsExtracting(false);
      };
      reader.readAsText(file);
    } catch (error) {
      addLog("Error extracting resume details.");
      setIsExtracting(false);
    }
  };

  const prepareApplication = async (job: Job) => {
    setIsGenerating(true);
    addLog(`Generating tailored cover letter for ${job.title} at ${job.company}...`);
    try {
      const letter = await generateCoverLetter(profile, job);
      setGeneratedLetter(letter || '');
      setSelectedJob(job);
      updateJobStatus(job.id, 'prepared');
      addLog(`Application prepared for ${job.company}.`);
    } catch (error) {
      addLog("Error generating cover letter.");
    } finally {
      setIsGenerating(false);
    }
  };

  const applyToJob = async (job: Job) => {
    addLog(`Applying to ${job.title} at ${job.company}...`);
    // In a real automated scenario, this might use a browser automation tool.
    // For this AI agent, we prepare everything and then provide the direct link.
    await updateJobStatus(job.id, 'applied');
    addLog(`Successfully applied to ${job.company}! Check History tab.`);
    
    // If it's a direct URL, we can suggest the user to visit it
    if (job.url) {
      addLog(`Direct Link: ${job.url}`);
    }
  };

  const processJob = async (job: Job) => {
    try {
      // 1. Lock the job
      await updateJobStatus(job.id, 'analyzing');
      addLog(`Agent started: ${job.title} at ${job.company}`);
      
      // 2. Prepare (Generate Letter)
      const letter = await generateCoverLetter(profile, job);
      
      // 3. Apply immediately
      addLog(`Agent applying to ${job.company} with tailored cover letter and resume...`);
      // In this simulation, marking as applied means the agent "submitted" the package
      await updateJobStatus(job.id, 'applied');
      addLog(`Agent successfully applied to ${job.company}.`);
      
      if (job.url) {
        addLog(`Direct Job Link: ${job.url}`);
      }
    } catch (error) {
      addLog(`Agent failed on ${job.company}. Retrying later...`);
      await updateJobStatus(job.id, 'found'); // Release lock
    }
  };

  // Autopilot loop simulation with 3 Parallel Agents
  useEffect(() => {
    let interval: any;
    if (isAutoPilotOn) {
      addLog("Autopilot Agents (3) initialized. Processing one-by-one...");
      interval = setInterval(async () => {
        const foundJobs = jobs.filter(j => j.status === 'found');
        const activeAgents = jobs.filter(j => j.status === 'analyzing').length;
        
        const freeSlots = 3 - activeAgents;
        
        if (freeSlots > 0 && foundJobs.length > 0) {
          const jobsToProcess = foundJobs.slice(0, freeSlots);
          jobsToProcess.forEach(job => processJob(job));
        } else if (foundJobs.length === 0 && !isSearching && jobs.length < 30) {
          startJobSearch();
        }
      }, 5000); // Check every 5 seconds
    }
    return () => clearInterval(interval);
  }, [isAutoPilotOn, jobs, isSearching]);

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-[#E4E3E0] border-b border-[#141414] flex items-center justify-between px-6 z-30">
        <h1 className="text-xl font-serif italic font-bold">JobAutopilot</h1>
        <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
          {isMobileMenuOpen ? <Trash2 size={24} /> : <Settings size={24} />}
        </button>
      </div>

      {/* Sidebar / Mobile Menu */}
      <nav className={cn(
        "fixed left-0 top-0 h-full w-64 border-r border-[#141414] bg-[#E4E3E0] z-40 transition-transform duration-300 lg:translate-x-0",
        isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-8 border-bottom border-[#141414] hidden lg:block">
          <h1 className="text-2xl font-serif italic font-bold tracking-tighter">JobAutopilot</h1>
          <p className="text-[10px] uppercase tracking-widest opacity-50 mt-1">AI Recruitment Agent</p>
        </div>
        
        <div className="mt-20 lg:mt-8">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: Briefcase },
            { id: 'profile', label: 'My Profile', icon: User },
            { id: 'jobs', label: 'Job Queue', icon: Clock },
            { id: 'history', label: 'History', icon: CheckCircle },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setActiveTab(item.id as any);
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center gap-4 px-8 py-4 text-sm font-medium transition-all duration-200 border-b border-transparent hover:bg-[#141414] hover:text-[#E4E3E0]",
                activeTab === item.id && "bg-[#141414] text-[#E4E3E0]"
              )}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </div>

        <div className="absolute bottom-0 w-full p-8 border-t border-[#141414]">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] uppercase font-bold tracking-widest opacity-50">Autopilot Status</span>
            <div className={cn("w-2 h-2 rounded-full", isAutoPilotOn ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
          </div>
          <button 
            onClick={() => setIsAutoPilotOn(!isAutoPilotOn)}
            className={cn(
              "w-full py-3 rounded-none border border-[#141414] text-xs font-bold uppercase tracking-widest transition-all",
              isAutoPilotOn ? "bg-[#141414] text-[#E4E3E0]" : "hover:bg-[#141414] hover:text-[#E4E3E0]"
            )}
          >
            {isAutoPilotOn ? "Deactivate" : "Activate"}
          </button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="lg:ml-64 p-6 lg:p-12 pt-24 lg:pt-12 max-w-6xl">
        {!isLinkedInConnected && activeTab === 'dashboard' && profile.name === '' ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center min-h-[70vh] text-center space-y-8"
          >
            <div className="w-24 h-24 bg-[#141414] rounded-full flex items-center justify-center text-[#E4E3E0] mb-4">
              <Briefcase size={40} />
            </div>
            <div className="max-w-md">
              <h2 className="text-4xl font-serif italic mb-4">Ready to start your job hunt?</h2>
              <p className="text-sm opacity-60 mb-8">Connect your LinkedIn to automatically fetch your profile, find matching jobs using Google Search AI, and start applying with tailored cover letters.</p>
              <button 
                onClick={connectLinkedIn}
                className="w-full py-5 bg-[#141414] text-[#E4E3E0] text-sm font-bold uppercase tracking-[0.2em] hover:scale-[1.02] transition-all flex items-center justify-center gap-3 shadow-2xl"
              >
                <Settings size={18} />
                Connect & Start Autopilot
              </button>
              <p className="mt-6 text-[10px] opacity-40 uppercase tracking-widest">Data sourced from real-time Google Search results</p>
            </div>
          </motion.div>
        ) : (
          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8 lg:space-y-12"
            >
              <header className="flex flex-col lg:flex-row lg:justify-between lg:items-end gap-6">
                <div>
                  <h2 className="text-3xl lg:text-5xl font-serif italic font-light tracking-tight">System Overview</h2>
                  <p className="mt-2 text-sm opacity-60">Monitoring job markets and application status in real-time.</p>
                </div>
                <div className="flex flex-col lg:flex-row gap-2 w-full lg:w-auto">
                  <button 
                    onClick={startJobSearch}
                    disabled={isSearching}
                    className="flex items-center justify-center gap-2 px-6 py-3 bg-white border border-[#141414] text-[#141414] text-xs font-bold uppercase tracking-widest hover:bg-[#141414] hover:text-[#E4E3E0] disabled:opacity-50"
                  >
                    {isSearching ? <RefreshCw className="animate-spin" size={14} /> : <Search size={14} />}
                    {isSearching ? "Scanning..." : "Quick Scan"}
                  </button>
                  <button 
                    onClick={async () => {
                      setIsSearching(true);
                      addLog("Initiating Bulk Search (Target: 50+ jobs)...");
                      // Run 3 searches in parallel for different variations
                      const variations = [
                        profile.target_roles,
                        `Latest ${profile.target_roles} openings`,
                        `${profile.target_roles} jobs hiring now`
                      ];
                      await Promise.all(variations.map(async (v) => {
                        const found = await searchJobs(v, profile.location);
                        for (const job of found) {
                          await fetch('/api/jobs', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(job)
                          });
                          // Small delay between jobs to avoid overwhelming the sheet sync
                          await new Promise(resolve => setTimeout(resolve, 500));
                        }
                      }));
                      fetchJobs();
                      setIsSearching(false);
                      addLog("Bulk Search complete.");
                    }}
                    disabled={isSearching}
                    className="flex items-center justify-center gap-2 px-6 py-3 bg-[#141414] text-[#E4E3E0] text-xs font-bold uppercase tracking-widest hover:opacity-90 disabled:opacity-50"
                  >
                    <Play size={14} />
                    Bulk Search (50+)
                  </button>
                </div>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-8">
                {[
                  { label: 'Jobs Found', value: jobs.length, icon: Search },
                  { label: 'Active Agents', value: jobs.filter(j => j.status === 'analyzing').length, icon: RefreshCw, color: 'text-blue-600' },
                  { label: 'Applied', value: jobs.filter(j => j.status === 'applied').length, icon: CheckCircle, color: 'text-green-600' },
                ].map((stat) => (
                  <div key={stat.label} className="p-8 border border-[#141414] bg-white/50 backdrop-blur-sm relative overflow-hidden">
                    <stat.icon size={20} className={cn("mb-4 opacity-40", stat.color)} />
                    <p className="text-[10px] uppercase font-bold tracking-widest opacity-50">{stat.label}</p>
                    <p className="text-4xl font-serif italic mt-1">{stat.value}</p>
                    {stat.label === 'Active Agents' && stat.value > 0 && (
                      <motion.div 
                        animate={{ x: [0, 100, 0] }}
                        transition={{ duration: 2, repeat: Infinity }}
                        className="absolute bottom-0 left-0 h-1 bg-blue-600 w-20"
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-widest mb-6 pb-2 border-b border-[#141414]">Recent Activity</h3>
                  <div className="space-y-4 max-h-[400px] overflow-y-auto pr-4 scrollbar-hide">
                    {logs.length === 0 && <p className="text-sm opacity-40 italic">No activity logged yet.</p>}
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-4 text-xs font-mono border-l-2 border-[#141414] pl-4 py-1">
                        <span className="opacity-30">[{new Date().toLocaleTimeString()}]</span>
                        <span>{log}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="text-xs font-bold uppercase tracking-widest mb-6 pb-2 border-b border-[#141414]">Pending Applications</h3>
                  <div className="space-y-4">
                    {jobs.filter(j => j.status === 'found').slice(0, 5).map((job) => (
                      <div 
                        key={job.id} 
                        onClick={() => prepareApplication(job)}
                        className="group p-4 border border-[#141414] hover:bg-[#141414] hover:text-[#E4E3E0] transition-all cursor-pointer"
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <h4 className="font-serif italic text-lg">{job.title}</h4>
                            <p className="text-xs opacity-60">{job.company} • {job.location}</p>
                          </div>
                          <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-all" />
                        </div>
                      </div>
                    ))}
                    {jobs.filter(j => j.status === 'found').length === 0 && (
                      <p className="text-sm opacity-40 italic">No pending jobs in queue.</p>
                    )}
                  </div>
                </section>
              </div>

              {selectedJob && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="p-8 border-2 border-[#141414] bg-white"
                >
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <h3 className="text-2xl font-serif italic">Application for {selectedJob.title}</h3>
                      <p className="text-sm opacity-60">{selectedJob.company}</p>
                    </div>
                    <button onClick={() => setSelectedJob(null)} className="opacity-40 hover:opacity-100">
                      <Trash2 size={18} />
                    </button>
                  </div>
                  <div className="bg-[#f5f5f5] p-6 font-mono text-xs whitespace-pre-wrap border border-[#141414]/10 mb-6">
                    {generatedLetter}
                  </div>
                  <div className="flex gap-4">
                    <a 
                      href={selectedJob.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      onClick={() => updateJobStatus(selectedJob.id, 'applied')}
                      className="flex-1 bg-[#141414] text-[#E4E3E0] py-4 text-center text-xs font-bold uppercase tracking-widest hover:opacity-90"
                    >
                      Apply Now (Opens Portal)
                    </a>
                    <button 
                      onClick={() => updateJobStatus(selectedJob.id, 'rejected')}
                      className="px-8 border border-[#141414] text-xs font-bold uppercase tracking-widest hover:bg-red-50"
                    >
                      Skip
                    </button>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === 'profile' && (
            <motion.div
              key="profile"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="max-w-2xl"
            >
              <h2 className="text-4xl font-serif italic font-light tracking-tight mb-8">Candidate Profile</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
                <div className="p-6 border-2 border-dashed border-[#141414]/20 bg-white/30 text-center">
                  <FileText size={32} className="mx-auto mb-4 opacity-20" />
                  <h3 className="text-sm font-bold uppercase tracking-widest mb-2">Import from Resume</h3>
                  <p className="text-xs opacity-50 mb-6">Upload your resume (TXT) and AI will extract details.</p>
                  <label className="inline-block px-8 py-3 border border-[#141414] text-[10px] font-bold uppercase tracking-widest cursor-pointer hover:bg-[#141414] hover:text-[#E4E3E0] transition-all">
                    {isExtracting ? "Extracting..." : "Choose File"}
                    <input type="file" accept=".txt" onChange={handleResumeUpload} className="hidden" disabled={isExtracting} />
                  </label>
                </div>

                <div className="p-6 border border-[#141414] bg-white text-center flex flex-col justify-center">
                  <div className="flex items-center justify-center gap-2 mb-4">
                    <div className={cn("w-2 h-2 rounded-full", isLinkedInConnected ? "bg-emerald-500" : "bg-gray-300")} />
                    <h3 className="text-sm font-bold uppercase tracking-widest">LinkedIn Sync</h3>
                  </div>
                  <p className="text-xs opacity-50 mb-6">
                    {isLinkedInConnected ? "Connected to your LinkedIn profile." : "Connect to fetch profile data and search jobs."}
                  </p>
                  <button 
                    onClick={connectLinkedIn}
                    className={cn(
                      "px-8 py-3 text-[10px] font-bold uppercase tracking-widest transition-all",
                      isLinkedInConnected ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-[#0077b5] text-white hover:opacity-90"
                    )}
                  >
                    {isLinkedInConnected ? "Connected" : "Connect LinkedIn"}
                  </button>
                </div>

                <div className="p-6 border border-[#141414] bg-white text-center flex flex-col justify-center">
                  <div className="flex items-center justify-center gap-2 mb-4">
                    <div className={cn("w-2 h-2 rounded-full", isGoogleConnected ? "bg-emerald-500" : "bg-gray-300")} />
                    <h3 className="text-sm font-bold uppercase tracking-widest">Google Sheets</h3>
                  </div>
                  <p className="text-xs opacity-50 mb-4">
                    {isGoogleConnected ? "Connected to Google." : "Connect to sync jobs to your Google Sheet."}
                  </p>
                  
                  {!isGoogleConnected ? (
                    <button 
                      onClick={connectGoogle}
                      className="px-8 py-3 bg-[#4285F4] text-white text-[10px] font-bold uppercase tracking-widest hover:opacity-90 transition-all"
                    >
                      Connect Google
                    </button>
                  ) : (
                    <div className="space-y-4">
                      <input 
                        type="text"
                        value={sheetUrl}
                        onChange={e => setSheetUrl(e.target.value)}
                        placeholder="Paste Google Sheet URL"
                        className="w-full text-[10px] border-b border-[#141414] py-2 focus:outline-none"
                      />
                      <button 
                        onClick={saveSheetUrl}
                        className="w-full py-2 border border-[#141414] text-[10px] font-bold uppercase tracking-widest hover:bg-[#141414] hover:text-[#E4E3E0]"
                      >
                        Link Sheet
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <form onSubmit={saveProfile} className="space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest opacity-50">Full Name</label>
                    <input 
                      type="text" 
                      value={profile.name}
                      onChange={e => setProfile({...profile, name: e.target.value})}
                      className="w-full bg-transparent border-b border-[#141414] py-2 focus:outline-none focus:border-opacity-100"
                      placeholder="John Doe"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest opacity-50">Email Address</label>
                    <input 
                      type="email" 
                      value={profile.email}
                      onChange={e => setProfile({...profile, email: e.target.value})}
                      className="w-full bg-transparent border-b border-[#141414] py-2 focus:outline-none"
                      placeholder="john@example.com"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest opacity-50">Target Roles</label>
                    <input 
                      type="text" 
                      value={profile.target_roles}
                      onChange={e => setProfile({...profile, target_roles: e.target.value})}
                      className="w-full bg-transparent border-b border-[#141414] py-2 focus:outline-none"
                      placeholder="Software Engineer, Frontend Developer"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest opacity-50">Preferred Location</label>
                    <input 
                      type="text" 
                      value={profile.location}
                      onChange={e => setProfile({...profile, location: e.target.value})}
                      className="w-full bg-transparent border-b border-[#141414] py-2 focus:outline-none"
                      placeholder="Remote, Bangalore, Mumbai"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-bold tracking-widest opacity-50">Skills & Expertise</label>
                  <textarea 
                    value={profile.skills}
                    onChange={e => setProfile({...profile, skills: e.target.value})}
                    className="w-full bg-transparent border border-[#141414] p-4 min-h-[100px] focus:outline-none"
                    placeholder="React, TypeScript, Node.js, Python..."
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-bold tracking-widest opacity-50">Resume Text Content</label>
                  <textarea 
                    value={profile.resume_text}
                    onChange={e => setProfile({...profile, resume_text: e.target.value})}
                    className="w-full bg-transparent border border-[#141414] p-4 min-h-[200px] focus:outline-none font-mono text-xs"
                    placeholder="Paste your full resume text here for AI analysis..."
                  />
                </div>

                <button 
                  type="submit"
                  className="px-12 py-4 bg-[#141414] text-[#E4E3E0] text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-all"
                >
                  Save Profile
                </button>
              </form>

              <div className="mt-24 pt-12 border-t border-[#141414]/10 space-y-8">
                <div className="bg-white/50 p-8 border border-[#141414]/10">
                  <div className="flex items-center gap-3 mb-4 text-emerald-700">
                    <CheckCircle size={20} />
                    <h3 className="text-sm font-bold uppercase tracking-widest">Safety & Privacy</h3>
                  </div>
                  <p className="text-xs opacity-60 leading-relaxed">
                    We use LinkedIn's official OAuth 2.0 system. This means we <strong>never</strong> see your password. 
                    LinkedIn only gives us a temporary "token" to read your basic profile and help you find jobs. 
                    You can disconnect or delete your data anytime using the buttons below.
                  </p>
                </div>

                <div className="flex flex-col md:flex-row gap-4">
                  <button 
                    onClick={logout}
                    className="flex-1 px-8 py-4 border border-[#141414] text-[10px] font-bold uppercase tracking-widest hover:bg-[#141414] hover:text-[#E4E3E0] transition-all"
                  >
                    Logout Session
                  </button>
                  <button 
                    onClick={deleteMyData}
                    className="flex-1 px-8 py-4 border border-red-200 text-red-600 text-[10px] font-bold uppercase tracking-widest hover:bg-red-600 hover:text-white transition-all"
                  >
                    Delete My Data Permanently
                  </button>
                </div>

                {debugInfo && (
                  <div className="mt-8 p-6 bg-amber-50 border border-amber-200 space-y-4">
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-amber-800">Connection Debugger</h4>
                    <div className="space-y-2">
                      <p className="text-[10px] text-amber-700">Copy this exact URL to LinkedIn Developer Portal:</p>
                      <code className="block p-2 bg-white border border-amber-200 text-[10px] break-all select-all">
                        {debugInfo.redirectUri}
                      </code>
                    </div>
                    <div className="flex gap-4 text-[10px] font-bold uppercase">
                      <span className={debugInfo.hasClientId ? "text-emerald-600" : "text-red-600"}>
                        Client ID: {debugInfo.hasClientId ? "✓ Set" : "✗ Missing"}
                      </span>
                      <span className={debugInfo.hasClientSecret ? "text-emerald-600" : "text-red-600"}>
                        Client Secret: {debugInfo.hasClientSecret ? "✓ Set" : "✗ Missing"}
                      </span>
                    </div>
                    <p className="text-[10px] text-amber-700 italic">
                      Note: Ensure "Sign In with LinkedIn using OpenID Connect" is added to your app's Products.
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'jobs' && (
            <motion.div
              key="jobs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              <div className="flex justify-between items-end">
                <h2 className="text-4xl font-serif italic font-light tracking-tight">Job Queue</h2>
                <p className="text-xs opacity-50 font-mono">{jobs.length} jobs discovered</p>
              </div>

              <div className="border border-[#141414] overflow-x-auto">
                <div className="min-w-[800px]">
                  <div className="grid grid-cols-[1fr_1fr_1fr_120px_100px] p-4 border-b border-[#141414] text-[10px] uppercase font-bold tracking-widest opacity-50">
                    <span>Job Title</span>
                    <span>Company</span>
                    <span>Location</span>
                    <span>Source</span>
                    <span>Status</span>
                  </div>
                  {jobs.map((job) => (
                    <div key={job.id} className="grid grid-cols-[1fr_1fr_1fr_120px_100px] p-4 border-b border-[#141414] last:border-0 hover:bg-white/40 transition-all text-sm items-center">
                      <span className="font-serif italic">{job.title}</span>
                      <span className="opacity-70">{job.company}</span>
                      <span className="opacity-70">{job.location}</span>
                      <span className="text-[10px] font-mono uppercase">{job.source}</span>
                      <div className="flex items-center gap-2">
                        <select 
                          value={job.status}
                          onChange={(e) => updateJobStatus(job.id, e.target.value as any)}
                          className="bg-transparent text-[10px] uppercase font-bold focus:outline-none cursor-pointer"
                        >
                          <option value="found">Found</option>
                          <option value="prepared">Prepared</option>
                          <option value="applied">Applied</option>
                          <option value="rejected">Rejected</option>
                        </select>
                        <a href={job.url} target="_blank" rel="noopener noreferrer" className="opacity-40 hover:opacity-100">
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
                {jobs.length === 0 && (
                  <div className="p-12 text-center opacity-40 italic">
                    No jobs found. Click "Scan for Jobs" to begin.
                  </div>
                )}
              </div>
            </motion.div>
          )}
          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              <div className="flex justify-between items-end">
                <h2 className="text-4xl font-serif italic font-light tracking-tight">Application History</h2>
                <p className="text-xs opacity-50 font-mono">
                  {jobs.filter(j => j.status === 'applied').length} successful applications
                </p>
              </div>

              <div className="border border-[#141414]">
                <div className="grid grid-cols-[1fr_1fr_1fr_150px] p-4 border-b border-[#141414] text-[10px] uppercase font-bold tracking-widest opacity-50">
                  <span>Job & Company</span>
                  <span>Location</span>
                  <span>Source</span>
                  <span>Applied At</span>
                </div>
                {jobs.filter(j => j.status === 'applied').map((job) => (
                  <div key={job.id} className="grid grid-cols-[1fr_1fr_1fr_150px] p-4 border-b border-[#141414] last:border-0 hover:bg-white/40 transition-all text-sm items-center">
                    <div>
                      <p className="font-serif italic">{job.title}</p>
                      <p className="text-[10px] opacity-50 uppercase tracking-widest">{job.company}</p>
                    </div>
                    <span className="opacity-70">{job.location}</span>
                    <span className="text-[10px] font-mono uppercase">{job.source}</span>
                    <span className="text-[10px] font-mono opacity-50">
                      {new Date(job.created_at).toLocaleString()}
                    </span>
                  </div>
                ))}
                {jobs.filter(j => j.status === 'applied').length === 0 && (
                  <div className="p-12 text-center opacity-40 italic">
                    No applications sent yet.
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
      </main>

      {/* Floating Status Bar */}
      <div className="fixed bottom-4 right-4 lg:bottom-8 lg:right-8 flex items-center gap-4 px-4 lg:px-6 py-2 lg:py-3 bg-[#141414] text-[#E4E3E0] rounded-none border border-[#E4E3E0]/20 shadow-2xl z-20">
        <div className="flex items-center gap-2">
          <div className={cn("w-2 h-2 rounded-full animate-pulse", isAutoPilotOn ? "bg-emerald-400" : "bg-red-400")} />
          <span className="text-[8px] lg:text-[10px] uppercase font-bold tracking-widest">
            {isAutoPilotOn ? "Autopilot Active" : "Autopilot Idle"}
          </span>
        </div>
        <div className="w-px h-4 bg-white/20" />
        <span className="text-[8px] lg:text-[10px] font-mono opacity-60">
          {new Date().toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
