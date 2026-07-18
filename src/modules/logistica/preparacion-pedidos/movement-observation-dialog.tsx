import { useState } from 'react'

interface MovementObservationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (observation: string) => void;
  label: string;
  isMoving: boolean;
  error?: string | null;
}

export function MovementObservationDialog({ isOpen, onClose, onConfirm, label, isMoving, error }: MovementObservationDialogProps) {
  const [observation, setObservation] = useState('');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div 
        className="fixed inset-0 bg-theme-base/80 backdrop-blur-sm" 
        onClick={!isMoving ? onClose : undefined} 
      />
      
      <div className="relative bg-theme-panel border border-theme-border shadow-2xl rounded-xl w-full max-w-md p-6 m-4 flex flex-col">
        <h3 className="text-lg font-semibold text-theme-text mb-2">Observación requerida</h3>
        <p className="text-sm font-medium mb-4 text-theme-text-muted">
          Estás a punto de <span className="font-bold text-theme-text">{label.toLowerCase()}</span>.
        </p>
        
        <textarea
          className="w-full bg-theme-base border border-theme-border rounded-lg p-3 text-sm text-theme-text mb-4 focus:border-theme-accent outline-none min-h-[100px] resize-none"
          placeholder="Indica el motivo de este cambio..."
          value={observation}
          onChange={e => setObservation(e.target.value)}
        />
        
        {error && <p className="text-xs text-red-500 mb-4">{error}</p>}
        
        <div className="flex gap-3 mt-auto">
          <button 
            onClick={!isMoving ? onClose : undefined}
            className="flex-1 py-2 bg-theme-border/50 text-theme-text hover:bg-theme-border/80 transition-colors rounded-lg text-sm font-medium disabled:opacity-50"
            disabled={isMoving}
          >
            Cancelar
          </button>
          <button 
            disabled={isMoving || observation.trim() === ''}
            onClick={() => onConfirm(observation)}
            className="flex-1 py-2 bg-theme-accent text-white hover:opacity-90 transition-opacity rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {isMoving ? 'Guardando...' : 'Confirmar devolución'}
          </button>
        </div>
      </div>
    </div>
  );
}
