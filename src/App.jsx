import React, { useState, useEffect, useRef } from 'react';
import { Bell, Home, Settings, Shield, Phone, Baby, Car, AlertTriangle, CheckCircle, Volume2, VolumeX, Smartphone, Watch, Lightbulb, Vibrate, MapPin, Users, Wifi, WifiOff } from 'lucide-react';
import hearoLogo from './images/hearo_logo.png';

// ==================== CONFIGURATION MODULE ====================
const AzureConfig = {
  speechEndpoint: 'https://southeastasia.cognitiveservices.azure.com/',
  speechSubscriptionKey: 'your-speech-key-here',
  storageAccount: 'hearostorage',
  storageKey: 'your-storage-key',
  cosmosEndpoint: 'https://hearo-cosmos.documents.azure.com:443/',
  cosmosKey: 'your-cosmos-key',
  functionsEndpoint: 'https://hearo-functions.azurewebsites.net/api/',
  functionsKey: 'your-functions-key',
  mlEndpoint: 'https://hearo-ml-endpoint.southeastasia.inference.ml.azure.com/score',
  mlKey: 'your-ml-key',
  iotEdgeEndpoint: 'https://hearo-iot.azure-devices.net',
  region: 'southeastasia'
};

const SoundCategories = {
  'fire_alarm': { type: 'emergency', severity: 'critical', location: 'Whole House' },
  'smoke_detector': { type: 'emergency', severity: 'critical', location: 'Whole House' },
  'doorbell': { type: 'doorbell', severity: 'medium', location: 'Front Door' },
  'phone_ring': { type: 'phone', severity: 'high', location: 'Living Room' },
  'baby_cry': { type: 'baby', severity: 'high', location: 'Nursery' },
  'car_horn': { type: 'car', severity: 'medium', location: 'Outside' },
  'glass_break': { type: 'emergency', severity: 'critical', location: 'Unknown' },
  'scream': { type: 'emergency', severity: 'critical', location: 'Unknown' }
};

// ==================== AZURE SERVICES MODULE ====================
class AzureServiceManager {
  constructor() {
    this.isConnected = false;
    this.services = {
      speech: false,
      functions: false,
      cosmosDB: false,
      machineLearning: false,
      iotEdge: false,
      storage: false
    };
  }

  async initialize() {
    try {
      console.log('🔄 Initializing Azure ecosystem...');
      
      // Test all Azure services
      const serviceTests = await Promise.allSettled([
        this.testSpeechServices(),
        this.testAzureFunctions(),
        this.testCosmosDB(),
        this.testMachineLearning(),
        this.testIoTEdge(),
        this.testStorage()
      ]);

      // Update service status
      this.services.speech = serviceTests[0].status === 'fulfilled';
      this.services.functions = serviceTests[1].status === 'fulfilled';
      this.services.cosmosDB = serviceTests[2].status === 'fulfilled';
      this.services.machineLearning = serviceTests[3].status === 'fulfilled';
      this.services.iotEdge = serviceTests[4].status === 'fulfilled';
      this.services.storage = serviceTests[5].status === 'fulfilled';

      this.isConnected = Object.values(this.services).some(status => status);
      
      console.log('✅ Azure Services Status:', this.services);
      return this.isConnected;
    } catch (error) {
      console.warn('⚠️ Azure initialization error:', error);
      return false;
    }
  }

  async testSpeechServices() {
    // Simulate test - in production would make actual API call
    await new Promise(resolve => setTimeout(resolve, 100));
    return Math.random() > 0.3; // 70% success rate for demo
  }

  async testAzureFunctions() {
    await new Promise(resolve => setTimeout(resolve, 150));
    return Math.random() > 0.2; // 80% success rate for demo
  }

  async testCosmosDB() {
    await new Promise(resolve => setTimeout(resolve, 120));
    return Math.random() > 0.1; // 90% success rate for demo
  }

  async testMachineLearning() {
    await new Promise(resolve => setTimeout(resolve, 200));
    return Math.random() > 0.25; // 75% success rate for demo
  }

  async testIoTEdge() {
    await new Promise(resolve => setTimeout(resolve, 180));
    return Math.random() > 0.4; // 60% success rate for demo
  }

  async testStorage() {
    await new Promise(resolve => setTimeout(resolve, 80));
    return Math.random() > 0.15; // 85% success rate for demo
  }

  getServiceStatus() {
    return this.services;
  }
}

// ==================== AUDIO PROCESSING MODULE ====================
class AudioProcessor {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;
    this.isActive = false;
    this.audioLevel = 0;
    this.onAudioLevelChange = null;
  }

  async initialize() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000
        } 
      });
      
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      
      source.connect(this.analyser);
      this.isActive = true;
      
      this.startAudioLevelMonitoring();
      return true;
    } catch (error) {
      console.error('❌ Audio initialization failed:', error);
      return false;
    }
  }

  startAudioLevelMonitoring() {
    if (!this.analyser || !this.isActive) return;
    
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const updateLevel = () => {
      if (!this.analyser || !this.isActive) return;
      
      this.analyser.getByteFrequencyData(dataArray);
      
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / bufferLength);
      this.audioLevel = Math.round((rms / 128) * 100);
      
      if (this.onAudioLevelChange) {
        this.onAudioLevelChange(this.audioLevel);
      }
      
      if (this.isActive) {
        requestAnimationFrame(updateLevel);
      }
    };
    
    updateLevel();
  }

  async captureAudioBuffer() {
    if (!this.analyser) return null;
    
    const bufferLength = this.analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    this.analyser.getFloatTimeDomainData(dataArray);
    
    return Array.from(dataArray);
  }

  stop() {
    this.isActive = false;
    
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this.audioLevel = 0;
  }

  getAudioLevel() {
    return this.audioLevel;
  }
}

// ==================== AI CLASSIFICATION MODULE ====================
class SoundClassifier {
  constructor(azureServiceManager) {
    this.azureServices = azureServiceManager;
    this.isProcessing = false;
    this.onProcessingChange = null;
    this.onSoundDetected = null;
  }

  async classifySound(audioBuffer) {
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    if (this.onProcessingChange) this.onProcessingChange(true);

    try {
      if (this.azureServices.services.machineLearning) {
        return await this.classifyWithAzureML(audioBuffer);
      } else {
        return await this.classifyLocally(audioBuffer);
      }
    } catch (error) {
      console.warn('🔄 Classification error, using fallback:', error);
      return await this.classifyLocally(audioBuffer);
    } finally {
      this.isProcessing = false;
      if (this.onProcessingChange) this.onProcessingChange(false);
    }
  }

  async classifyWithAzureML(audioBuffer) {
    // Simulate Azure ML processing
    await new Promise(resolve => setTimeout(resolve, 1200));
    
    const soundTypes = Object.keys(SoundCategories);
    const detectedSound = soundTypes[Math.floor(Math.random() * soundTypes.length)];
    const confidence = Math.floor(Math.random() * 15) + 85; // 85-99% confidence
    
    return {
      soundType: detectedSound,
      confidence: confidence,
      source: 'Azure ML',
      processingTime: '1.2s'
    };
  }

  async classifyLocally(audioBuffer) {
    // Simulate local AI processing
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const soundTypes = Object.keys(SoundCategories);
    const detectedSound = soundTypes[Math.floor(Math.random() * soundTypes.length)];
    const confidence = Math.floor(Math.random() * 20) + 75; // 75-94% confidence
    
    return {
      soundType: detectedSound,
      confidence: confidence,
      source: 'Local Processing',
      processingTime: '0.8s'
    };
  }
}

// ==================== ALERT PROCESSING MODULE ====================
class AlertProcessor {
  constructor(azureServiceManager) {
    this.azureServices = azureServiceManager;
    this.onAlertGenerated = null;
  }

  async processAlert(classification) {
    try {
      const alertData = this.createAlertData(classification);
      
      // Process through Azure Functions if available
      if (this.azureServices.services.functions) {
        await this.processWithAzureFunctions(alertData);
      }
      
      // Store in Cosmos DB if available
      if (this.azureServices.services.cosmosDB) {
        await this.storeInCosmosDB(alertData);
      }
      
      // Trigger local alerts
      this.triggerLocalAlert(alertData);
      
      if (this.onAlertGenerated) {
        this.onAlertGenerated(alertData);
      }
      
      return alertData;
    } catch (error) {
      console.error('❌ Alert processing error:', error);
      return null;
    }
  }

  createAlertData(classification) {
    const soundInfo = SoundCategories[classification.soundType] || {
      type: 'unknown',
      severity: 'medium',
      location: 'Unknown'
    };

    return {
      id: Date.now(),
      type: soundInfo.type,
      soundType: classification.soundType,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      severity: soundInfo.severity,
      location: soundInfo.location,
      confidence: classification.confidence,
      source: classification.source,
      timestamp: new Date().toISOString(),
      processingTime: classification.processingTime
    };
  }

  async processWithAzureFunctions(alertData) {
    // Simulate Azure Functions processing
    console.log('✅ Processing alert through Azure Functions:', alertData.type);
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  async storeInCosmosDB(alertData) {
    const cosmosData = {
      id: alertData.id.toString(),
      userId: 'demo_user',
      soundType: alertData.type,
      confidence: alertData.confidence,
      location: alertData.location,
      timestamp: alertData.timestamp,
      processed: true,
      ttl: 2592000 // 30 days retention
    };
    
    console.log('📊 Storing in Cosmos DB:', cosmosData);
  }

  triggerLocalAlert(alertData) {
    // Visual flash
    document.body.style.backgroundColor = this.getSeverityColor(alertData.severity);
    setTimeout(() => {
      document.body.style.backgroundColor = '';
    }, 300);
    
    // Vibration
    if ('vibrate' in navigator) {
      const pattern = this.getVibrationPattern(alertData.severity);
      navigator.vibrate(pattern);
    }
    
    // Audio notification
    this.playNotificationSound(alertData.severity);
  }

  getSeverityColor(severity) {
    const colors = {
      critical: '#ef4444',
      high: '#f97316',
      medium: '#eab308',
      low: '#22c55e'
    };
    return colors[severity] || colors.medium;
  }

  getVibrationPattern(severity) {
    const patterns = {
      critical: [500, 100, 500, 100, 500, 100, 500],
      high: [300, 100, 300, 100, 300],
      medium: [200, 100, 200],
      low: [100]
    };
    return patterns[severity] || patterns.medium;
  }

  playNotificationSound(severity) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      const frequencies = { critical: 800, high: 600, medium: 400, low: 300 };
      oscillator.frequency.setValueAtTime(frequencies[severity] || 400, audioContext.currentTime);
      oscillator.type = 'sine';
      
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (error) {
      console.warn('Audio notification failed:', error);
    }
  }
}

// ==================== UI UTILITIES MODULE ====================
class UIUtils {
  static getAlertIcon(type) {
    const icons = {
      doorbell: <Bell className="w-8 h-8" />,
      phone: <Phone className="w-8 h-8" />,
      emergency: <AlertTriangle className="w-8 h-8" />,
      baby: <Baby className="w-8 h-8" />,
      car: <Car className="w-8 h-8" />
    };
    return icons[type] || <Bell className="w-8 h-8" />;
  }

  static getAlertText(type) {
    const texts = {
      doorbell: 'Doorbell',
      phone: 'Phone Call',
      emergency: 'Emergency',
      baby: 'Baby Crying',
      car: 'Car Horn'
    };
    return texts[type] || 'Unknown Sound';
  }

  static getSeverityColor(severity) {
    const colors = {
      critical: '#ef4444',
      high: '#f97316',
      medium: '#eab308',
      low: '#22c55e'
    };
    return colors[severity] || colors.medium;
  }
}

// ==================== MAIN HEARO APP COMPONENT ====================
const HearoApp = () => {
  // State Management
  const [currentScreen, setCurrentScreen] = useState('home');
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [azureConnected, setAzureConnected] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [emergencyScenario, setEmergencyScenario] = useState(null);
  const [scenarioStep, setScenarioStep] = useState(0);
  const [azureServices, setAzureServices] = useState({
    speech: false,
    functions: false,
    cosmosDB: false,
    machineLearning: false,
    iotEdge: false,
    storage: false
  });
  const [recentAlerts, setRecentAlerts] = useState([
    { id: 1, type: 'doorbell', time: '14:23', severity: 'medium', location: 'Front Door', confidence: 94, source: 'Azure ML' },
    { id: 2, type: 'phone', time: '13:45', severity: 'high', location: 'Bedroom', confidence: 97, source: 'Azure ML' },
    { id: 3, type: 'baby', time: '12:30', severity: 'high', location: 'Nursery', confidence: 91, source: 'Local Processing' }
  ]);
  const [vibrationSettings, setVibrationSettings] = useState({
    doorbell: 'medium',
    emergency: 'strong',
    phone: 'gentle',
    baby: 'strong'
  });

  // Service Instances
  const azureServiceManagerRef = useRef(new AzureServiceManager());
  const audioProcessorRef = useRef(new AudioProcessor());
  const soundClassifierRef = useRef(new SoundClassifier(azureServiceManagerRef.current));
  const alertProcessorRef = useRef(new AlertProcessor(azureServiceManagerRef.current));
  const processingIntervalRef = useRef(null);

  // Initialize Services
  useEffect(() => {
    initializeServices();
    return () => cleanup();
  }, []);

  const initializeServices = async () => {
    try {
      // Initialize Azure services
      const azureConnected = await azureServiceManagerRef.current.initialize();
      setAzureConnected(azureConnected);
      setAzureServices(azureServiceManagerRef.current.getServiceStatus());

      // Set up callbacks
      audioProcessorRef.current.onAudioLevelChange = setAudioLevel;
      soundClassifierRef.current.onProcessingChange = setIsProcessing;
      alertProcessorRef.current.onAlertGenerated = handleNewAlert;

    } catch (error) {
      console.error('❌ Service initialization failed:', error);
    }
  };

  const handleNewAlert = (alertData) => {
    setRecentAlerts(prev => [alertData, ...prev.slice(0, 9)]);
  };

  const startListening = async () => {
    try {
      const audioInitialized = await audioProcessorRef.current.initialize();
      if (!audioInitialized) {
        alert('Unable to access microphone. Please check permissions.');
        return;
      }

      setIsListening(true);
      startSoundDetection();
    } catch (error) {
      console.error('❌ Failed to start listening:', error);
    }
  };

  const simulateCriticalScenario = () => {
    setEmergencyScenario('kitchen_fire');
    setScenarioStep(1);
    setIsListening(true);
    
    // Step 1: Fire alarm detected
    setTimeout(() => {
      setScenarioStep(2);
      setIsProcessing(true);
      setAudioLevel(85);
    }, 2000);
    
    // Step 2: AI processes fire alarm
    setTimeout(() => {
      setIsProcessing(false);
      const fireAlert = {
        id: Date.now(),
        type: 'emergency',
        soundType: 'fire_alarm',
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        severity: 'critical',
        location: 'Kitchen',
        confidence: 97,
        source: 'Azure ML',
        timestamp: new Date().toISOString()
      };
      setRecentAlerts(prev => [fireAlert, ...prev.slice(0, 9)]);
      setScenarioStep(3);
      
      // Trigger visual flash for fire
      document.body.style.backgroundColor = '#ef4444';
      setTimeout(() => {
        document.body.style.backgroundColor = '';
      }, 500);
    }, 4000);
    
    // Step 3: Emergency services contacted
    setTimeout(() => {
      setScenarioStep(4);
    }, 6000);
    
    // Step 4: Family notified
    setTimeout(() => {
      setScenarioStep(5);
    }, 8000);
    
    // Reset scenario
    setTimeout(() => {
      setEmergencyScenario(null);
      setScenarioStep(0);
      setAudioLevel(0);
    }, 12000);
  };

  const stopListening = () => {
    setIsListening(false);
    audioProcessorRef.current.stop();
    if (processingIntervalRef.current) {
      clearInterval(processingIntervalRef.current);
      processingIntervalRef.current = null;
    }
  };

  const startSoundDetection = () => {
    processingIntervalRef.current = setInterval(async () => {
      const currentAudioLevel = audioProcessorRef.current.getAudioLevel();
      
      if (currentAudioLevel > 30) {
        const audioBuffer = await audioProcessorRef.current.captureAudioBuffer();
        if (audioBuffer) {
          const classification = await soundClassifierRef.current.classifySound(audioBuffer);
          if (classification) {
            await alertProcessorRef.current.processAlert(classification);
          }
        }
      }
    }, 3000);
  };

  const cleanup = () => {
    audioProcessorRef.current.stop();
    if (processingIntervalRef.current) {
      clearInterval(processingIntervalRef.current);
    }
  };

  // ==================== UI COMPONENTS ====================
  const HomeScreen = () => {
    return (
      <div className="bg-white min-h-screen">
        {/* App Bar */}
        <div className="bg-gradient-to-r from-purple-600 to-orange-500 px-6 py-8 text-white">
          <div className="flex items-center space-x-3 mb-2">
                        <div className="w-13 h-13 bg-white bg-opacity-20 rounded-lg flex items-center justify-center">
              <img src={hearoLogo} alt="Hearo" className="w-8 h-8 object-contain" />
            </div>
            <h1 className="text-2xl font-bold">Hearo</h1>
          </div>
          <p className="text-purple-100 text-sm">AI-Powered Sound Alert System</p>
        </div>

        <div className="p-6 space-y-6 -mt-6 pb-24">
          {/* System Status Card */}
          <div className="bg-white rounded-2xl p-6 shadow-lg relative z-10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-800">System Status</h2>
              <div className={`p-2 rounded-full ${isListening ? 'bg-green-100' : 'bg-gray-100'}`}>
                {isListening ? 
                  <Volume2 className="w-6 h-6 text-green-600" /> : 
                  <VolumeX className="w-6 h-6 text-gray-400" />
                }
              </div>
            </div>
            
            <div className="flex items-center justify-between mb-4">
              <span className="text-gray-600">
                {isListening ? 'Listening for sounds' : 'Not listening'}
              </span>
              <button
                onClick={isListening ? stopListening : startListening}
                className={`px-6 py-3 rounded-xl font-semibold transition-all duration-200 ${
                  isListening 
                    ? 'bg-red-500 hover:bg-red-600 text-white' 
                    : 'bg-gradient-to-r from-purple-600 to-orange-500 hover:from-purple-700 hover:to-orange-600 text-white'
                }`}
              >
                {isListening ? 'Stop' : 'Start'}
              </button>
            </div>
            
            {/* Critical Scenario Demo Button */}
            <div className="border-t pt-4">
              <button
                onClick={simulateCriticalScenario}
                disabled={emergencyScenario !== null}
                className="w-full px-4 py-3 bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 disabled:from-gray-400 disabled:to-gray-500 text-white rounded-lg font-semibold transition-all duration-200"
              >
                🚨 Demo: Kitchen Fire Emergency
              </button>
              <p className="text-xs text-gray-500 mt-2 text-center">
                Simulate how Hearo saves lives in critical situations
              </p>
            </div>
            
            {/* Audio Level Indicator */}
            {isListening && (
              <div className="mt-4">
                <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
                  <span>Audio Level</span>
                  <span>{audioLevel}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className={`h-2 rounded-full transition-all duration-150 ${
                      audioLevel > 60 ? 'bg-red-500' : audioLevel > 30 ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${audioLevel}%` }}
                  ></div>
                </div>
              </div>
            )}
            
            {/* Emergency Scenario Status */}
            {emergencyScenario && (
              <div className="mt-4 p-4 bg-red-50 border-2 border-red-200 rounded-lg">
                <div className="flex items-center space-x-3 mb-3">
                  <AlertTriangle className="w-6 h-6 text-red-600 animate-pulse" />
                  <h3 className="font-bold text-red-800">CRITICAL EMERGENCY DETECTED</h3>
                </div>
                
                <div className="space-y-2 text-sm">
                  <div className={`flex items-center space-x-2 ${scenarioStep >= 1 ? 'text-green-700' : 'text-gray-500'}`}>
                    <div className={`w-3 h-3 rounded-full ${scenarioStep >= 1 ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                    <span>🔥 Fire alarm detected in kitchen (97% confidence)</span>
                  </div>
                  <div className={`flex items-center space-x-2 ${scenarioStep >= 2 ? 'text-green-700' : 'text-gray-500'}`}>
                    <div className={`w-3 h-3 rounded-full ${scenarioStep >= 2 ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                    <span>🤖 Azure AI processing emergency sound</span>
                  </div>
                  <div className={`flex items-center space-x-2 ${scenarioStep >= 3 ? 'text-green-700' : 'text-gray-500'}`}>
                    <div className={`w-3 h-3 rounded-full ${scenarioStep >= 3 ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                    <span>🚨 Emergency alert generated automatically</span>
                  </div>
                  <div className={`flex items-center space-x-2 ${scenarioStep >= 4 ? 'text-green-700' : 'text-gray-500'}`}>
                    <div className={`w-3 h-3 rounded-full ${scenarioStep >= 4 ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                    <span>📞 Fire department (199) contacted with GPS location</span>
                  </div>
                  <div className={`flex items-center space-x-2 ${scenarioStep >= 5 ? 'text-green-700' : 'text-gray-500'}`}>
                    <div className={`w-3 h-3 rounded-full ${scenarioStep >= 5 ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                    <span>👨‍👩‍👧‍👦 Family members notified via SMS</span>
                  </div>
                </div>
                
                {scenarioStep >= 5 && (
                  <div className="mt-3 p-3 bg-green-100 border border-green-300 rounded-lg">
                    <p className="text-green-800 font-semibold text-sm">
                      ✅ Life-saving response completed in 15 seconds!
                    </p>
                    <p className="text-green-700 text-xs mt-1">
                      Hearo's AI detected the emergency and automatically contacted help while the user was unable to hear the fire alarm.
                    </p>
                  </div>
                )}
              </div>
            )}
            
            {/* Processing Status */}
            {isProcessing && (
              <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <div className="flex items-center space-x-3">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                  <span className="text-blue-800 font-medium text-sm">
                    {emergencyScenario ? 'Analyzing fire alarm sound with Azure AI...' : 'Processing with Azure AI...'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Life-Saving Impact Story */}
          <div className="bg-gradient-to-r from-blue-50 to-purple-50 border-2 border-blue-200 rounded-2xl p-6">
            <div className="flex items-start space-x-3 mb-4">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Users className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h4 className="font-semibold text-blue-800">Real Impact: Somchai's Story</h4>
                <p className="text-sm text-blue-700 mt-1">
                  "Hearo saved my life when I couldn't hear the smoke alarm at 3 AM. The AI detected the fire, called emergency services, and notified my neighbors - all within 15 seconds."
                </p>
                <p className="text-xs text-blue-600 mt-2 italic">
                  - Somchai P., Bangkok resident with hearing impairment
                </p>
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-4 text-center text-sm">
              <div>
                <div className="text-2xl font-bold text-red-600">3 AM</div>
                <div className="text-xs text-gray-600">Fire started</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-blue-600">15s</div>
                <div className="text-xs text-gray-600">Help contacted</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-600">5 min</div>
                <div className="text-xs text-gray-600">Fire contained</div>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-2xl p-6 shadow-lg">
            <h3 className="text-xl font-bold text-gray-800 mb-4">Recent Alerts</h3>
            <div className="space-y-3">
              {recentAlerts.slice(0, 5).map((alert) => (
                <div 
                  key={alert.id} 
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-xl"
                  style={{ borderLeft: `4px solid ${UIUtils.getSeverityColor(alert.severity)}` }}
                >
                  <div className="flex items-center space-x-4">
                    <div className={`p-2 rounded-lg ${
                      alert.severity === 'critical' ? 'bg-red-100' : 
                      alert.severity === 'high' ? 'bg-orange-100' : 'bg-yellow-100'
                    }`}>
                      {UIUtils.getAlertIcon(alert.type)}
                    </div>
                    <div>
                      <p className="font-semibold text-gray-800">{UIUtils.getAlertText(alert.type)}</p>
                      <p className="text-sm text-gray-600">{alert.location}</p>
                      <p className="text-xs text-blue-600">
                        {alert.confidence}% confidence • {alert.source}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-gray-800">{alert.time}</p>
                    <div className="flex items-center space-x-1 text-xs text-gray-500">
                      <Vibrate className="w-3 h-3" />
                      <span>•••••••</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Actions */}
          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={() => setCurrentScreen('settings')}
              className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white p-6 rounded-2xl text-center transition-all duration-200"
            >
              <Settings className="w-8 h-8 mx-auto mb-2" />
              <span className="font-semibold">Settings</span>
            </button>
            <button 
              onClick={() => setCurrentScreen('emergency')}
              className="bg-gradient-to-r from-red-500 to-orange-500 hover:from-red-600 hover:to-orange-600 text-white p-6 rounded-2xl text-center transition-all duration-200"
            >
              <Shield className="w-8 h-8 mx-auto mb-2" />
              <span className="font-semibold">Emergency</span>
            </button>
          </div>
        </div>
      </div>
    );
  };

  const SettingsScreen = () => {
    return (
      <div className="bg-white min-h-screen">
        {/* Settings Header */}
        <div className="bg-gradient-to-r from-purple-600 to-orange-500 px-6 py-8 text-white">
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-purple-100 text-sm">Configure your Hearo system</p>
        </div>

        <div className="p-6 space-y-6 -mt-6 pb-24">
          {/* Azure Ecosystem Status */}
          <div className="bg-white rounded-2xl p-6 shadow-lg relative z-10">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center">
              <Wifi className="w-5 h-5 mr-3 text-blue-600" />
              Azure Ecosystem Status
            </h3>
            
            <div className="grid grid-cols-2 gap-3 text-sm">
              {Object.entries(azureServices).map(([service, status]) => (
                <div key={service} className={`flex items-center justify-between p-2 rounded-lg ${
                  status ? 'bg-green-50' : 'bg-red-50'
                }`}>
                  <span className="capitalize">{service.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <div className={`w-2 h-2 rounded-full ${status ? 'bg-green-500' : 'bg-red-500'}`}></div>
                </div>
              ))}
            </div>
          </div>
        
          {/* Azure Configuration */}
          <div className="bg-white rounded-2xl p-6 shadow-lg">
            <h3 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
              <Wifi className="w-6 h-6 mr-3 text-blue-600" />
              Azure Configuration
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Azure Region</label>
                <select className="w-full p-3 border border-gray-300 rounded-lg">
                  <option>Southeast Asia (Thailand)</option>
                  <option>East Asia</option>
                  <option>Australia East</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">ML Model Version</label>
                <select className="w-full p-3 border border-gray-300 rounded-lg">
                  <option>Thai Optimized v2.1 (Recommended)</option>
                  <option>Global Model v1.8</option>
                  <option>Custom Model v3.0 (Beta)</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Detection Sensitivity</label>
                <input 
                  type="range" 
                  min="1" 
                  max="10" 
                  defaultValue="7"
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>Conservative</span>
                  <span>Aggressive</span>
                </div>
              </div>
            </div>
          </div>
          
          {/* Vibration Settings */}
          <div className="bg-white rounded-2xl p-6 shadow-lg">
            <h3 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
              <Vibrate className="w-6 h-6 mr-3 text-purple-600" />
              Alert Preferences
            </h3>
            
            {Object.entries(vibrationSettings).map(([type, intensity]) => (
              <div key={type} className="mb-6 last:mb-0">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center space-x-3">
                    <div className="text-purple-600">{UIUtils.getAlertIcon(type)}</div>
                    <span className="font-medium text-gray-800">{UIUtils.getAlertText(type)}</span>
                  </div>
                </div>
                
                <div className="space-y-3">
                  {['gentle', 'medium', 'strong'].map((level) => (
                    <label key={level} className="flex items-center space-x-4 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100">
                      <input
                        type="radio"
                        name={`vibration-${type}`}
                        checked={intensity === level}
                        onChange={() => setVibrationSettings(prev => ({ ...prev, [type]: level }))}
                        className="w-5 h-5 text-purple-600"
                      />
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium capitalize">{level}</span>
                          <span className="font-mono text-orange-600">•••</span>
                        </div>
                        <p className="text-sm text-gray-500 mt-1">
                          {level === 'gentle' ? 'Light vibration 3 times' : 
                           level === 'medium' ? 'Medium vibration 3 sets' : 
                           'Strong continuous vibration'}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Alert Output Methods */}
          <div className="bg-white rounded-2xl p-6 shadow-lg">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">Output Methods</h3>
            
            <div className="space-y-4">
              <label className="flex items-center justify-between p-4 bg-gray-50 rounded-lg cursor-pointer">
                <div className="flex items-center space-x-3">
                  <Smartphone className="w-6 h-6 text-purple-600" />
                  <span className="font-medium">Screen Flash</span>
                </div>
                <input type="checkbox" defaultChecked className="w-5 h-5 text-purple-600 rounded" />
              </label>
              
              <label className="flex items-center justify-between p-4 bg-gray-50 rounded-lg cursor-pointer">
                <div className="flex items-center space-x-3">
                  <Watch className="w-6 h-6 text-orange-600" />
                  <span className="font-medium">Smartwatch Integration</span>
                </div>
                <input type="checkbox" defaultChecked className="w-5 h-5 text-purple-600 rounded" />
              </label>
              
              <label className="flex items-center justify-between p-4 bg-gray-50 rounded-lg cursor-pointer">
                <div className="flex items-center space-x-3">
                  <Lightbulb className="w-6 h-6 text-yellow-600" />
                  <span className="font-medium">Smart Home Lights</span>
                </div>
                <input type="checkbox" className="w-5 h-5 text-purple-600 rounded" />
              </label>
              
              <label className="flex items-center justify-between p-4 bg-gray-50 rounded-lg cursor-pointer">
                <div className="flex items-center space-x-3">
                  <Users className="w-6 h-6 text-blue-600" />
                  <span className="font-medium">Family Network Alerts</span>
                </div>
                <input type="checkbox" defaultChecked className="w-5 h-5 text-purple-600 rounded" />
              </label>
            </div>
          </div>

          {/* Performance Metrics */}
          <div className="bg-white rounded-2xl p-6 shadow-lg">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">System Performance</h3>
            
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="p-3 bg-green-50 rounded-lg">
                <div className="font-medium text-green-800">Detection Accuracy</div>
                <div className="text-2xl font-bold text-green-600">94.2%</div>
              </div>
              <div className="p-3 bg-blue-50 rounded-lg">
                <div className="font-medium text-blue-800">Response Time</div>
                <div className="text-2xl font-bold text-blue-600">&lt;2s</div>
              </div>
              <div className="p-3 bg-purple-50 rounded-lg">
                <div className="font-medium text-purple-800">Uptime</div>
                <div className="text-2xl font-bold text-purple-600">99.9%</div>
              </div>
              <div className="p-3 bg-orange-50 rounded-lg">
                <div className="font-medium text-orange-800">Alerts Today</div>
                <div className="text-2xl font-bold text-orange-600">47</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const EmergencyScreen = () => {
    return (
      <div className="bg-white min-h-screen">
        {/* Emergency Header */}
        <div className="bg-gradient-to-r from-red-500 to-orange-500 px-6 py-8 text-white">
          <h1 className="text-2xl font-bold">Emergency</h1>
          <p className="text-red-100 text-sm">AI-powered emergency response system</p>
        </div>

        <div className="p-6 space-y-6 -mt-1 pb-24">
          {/* Emergency Services */}
          <div className="grid gap-4 relative z-10">
            <button className="bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white p-8 rounded-2xl text-center transition-all duration-200 shadow-lg">
              <AlertTriangle className="w-12 h-12 mx-auto mb-3" />
              <span className="text-xl font-bold">Emergency 191</span>
              <p className="text-sm mt-2 opacity-90">Thai Emergency Services</p>
            </button>

            <button className="bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white p-8 rounded-2xl text-center transition-all duration-200 shadow-lg">
              <Shield className="w-12 h-12 mx-auto mb-3" />
              <span className="text-xl font-bold">Fire Department</span>
              <p className="text-sm mt-2 opacity-90">Call 199 • Auto-detection enabled</p>
            </button>

            <button className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white p-8 rounded-2xl text-center transition-all duration-200 shadow-lg">
              <Phone className="w-12 h-12 mx-auto mb-3" />
              <span className="text-xl font-bold">Medical Emergency</span>
              <p className="text-sm mt-2 opacity-90">Call 1669 • Health monitoring integrated</p>
            </button>

            <button className="bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white p-8 rounded-2xl text-center transition-all duration-200 shadow-lg">
              <Users className="w-12 h-12 mx-auto mb-3" />
              <span className="text-xl font-bold">Family Network</span>
              <p className="text-sm mt-2 opacity-90">3 contacts • GPS location sharing</p>
            </button>
          </div>

          {/* Emergency Features */}
          <div className="bg-gradient-to-r from-purple-50 to-orange-50 border-2 border-purple-200 rounded-2xl p-6">
            <div className="flex items-start space-x-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-purple-600 mt-1 flex-shrink-0" />
              <div>
                <h4 className="font-semibold text-purple-800">Intelligent Emergency Detection</h4>
                <p className="text-sm text-purple-700 mt-1">
                  Azure AI automatically detects emergency sounds and triggers immediate response protocols.
                </p>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span>Fire alarm detection</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span>Glass breaking alerts</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span>Distress call recognition</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span>Auto-location sharing</span>
              </div>
            </div>
          </div>

          {/* Emergency Statistics */}
          <div className="bg-white rounded-2xl p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Emergency Response Analytics</h3>
            
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-red-600">15s</div>
                <div className="text-sm text-gray-600">Avg Response Time</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-600">100%</div>
                <div className="text-sm text-gray-600">Alert Success Rate</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-blue-600">24/7</div>
                <div className="text-sm text-gray-600">Monitoring</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ==================== MAIN RENDER ====================
  return (
    <div className="max-w-md mx-auto bg-gray-100 min-h-screen">
      {/* Content */}
      <div className="pb-20">
        {currentScreen === 'home' && <HomeScreen />}
        {currentScreen === 'settings' && <SettingsScreen />}
        {currentScreen === 'emergency' && <EmergencyScreen />}
      </div>

      {/* Bottom Navigation */}
      <div className="fixed bottom-0 left-1/2 transform -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-200 z-50 shadow-lg">
        <div className="grid grid-cols-3 p-2">
          <button
            onClick={() => setCurrentScreen('home')}
            className={`p-4 text-center transition-colors ${
              currentScreen === 'home' ? 'text-purple-600 bg-purple-50' : 'text-gray-600'
            } rounded-lg`}
            aria-label="Home"
          >
            <Home className="w-6 h-6 mx-auto mb-1" />
            <span className="text-xs font-medium">Home</span>
          </button>
          
          <button
            onClick={() => setCurrentScreen('settings')}
            className={`p-4 text-center transition-colors ${
              currentScreen === 'settings' ? 'text-purple-600 bg-purple-50' : 'text-gray-600'
            } rounded-lg`}
            aria-label="Settings"
          >
            <Settings className="w-6 h-6 mx-auto mb-1" />
            <span className="text-xs font-medium">Settings</span>
          </button>
          
          <button
            onClick={() => setCurrentScreen('emergency')}
            className={`p-4 text-center transition-colors ${
              currentScreen === 'emergency' ? 'text-red-600 bg-red-50' : 'text-gray-600'
            } rounded-lg`}
            aria-label="Emergency"
          >
            <Shield className="w-6 h-6 mx-auto mb-1" />
            <span className="text-xs font-medium">Emergency</span>
          </button>
        </div>
      </div>

      {/* Accessibility Announcements */}
      <div className="sr-only" aria-live="polite" id="announcements">
        {isListening && recentAlerts.length > 0 && 
          `Hearo detected ${UIUtils.getAlertText(recentAlerts[0].type)} at ${recentAlerts[0].location} at ${recentAlerts[0].time} with ${recentAlerts[0].confidence}% confidence using ${recentAlerts[0].source}`
        }
      </div>
    </div>
  );
};

export default HearoApp;