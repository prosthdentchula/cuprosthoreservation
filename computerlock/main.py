import tkinter as tk
from tkinter import messagebox
import pyotp

import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# --- CONFIGURATION ---
# The shared secret for the TOTP. 
# Staff should put this in Google Authenticator, Authy, or Microsoft Authenticator.
# Note: Base32 strings only allow A-Z and 2-7.
TOTP_SECRET = os.getenv("TOTP_SECRET", "JBSWY3DPEHPK3PXP") 

# The master key that will always bypass the lock
MASTER_KEY = os.getenv("MASTER_KEY", "ADMIN")

class LockScreen:
    def __init__(self, root):
        self.root = root
        self.root.title("Computer Lock")
        
        # Make it full screen and always on top
        self.root.attributes("-fullscreen", True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg="#2c3e50")
        
        # Disable closing the window via Alt+F4 or the 'X' button
        self.root.protocol("WM_DELETE_WINDOW", self.disable_event)
        
        # Initialize the TOTP generator with our secret key
        self.totp = pyotp.TOTP(TOTP_SECRET)

        self.build_ui()

    def build_ui(self):
        # Center frame to hold all the UI elements
        frame = tk.Frame(self.root, bg="#2c3e50")
        frame.place(relx=0.5, rely=0.5, anchor="center")

        lbl_title = tk.Label(frame, text="Equipment Locked", font=("Helvetica", 36, "bold"), bg="#2c3e50", fg="white")
        lbl_title.pack(pady=20)

        lbl_inst = tk.Label(frame, text="Please enter the PIN provided by department staff.", font=("Helvetica", 14), bg="#2c3e50", fg="#ecf0f1")
        lbl_inst.pack(pady=10)

        self.entry_pin = tk.Entry(frame, font=("Helvetica", 24), justify="center")
        self.entry_pin.pack(pady=20)
        
        # Let the user press "Enter" to submit
        self.entry_pin.bind("<Return>", self.check_pin)
        self.entry_pin.focus()

        btn_unlock = tk.Button(frame, text="Unlock", font=("Helvetica", 16, "bold"), bg="#27ae60", fg="white", command=self.check_pin, width=15)
        btn_unlock.pack(pady=10)

        self.lbl_error = tk.Label(frame, text="", font=("Helvetica", 12, "bold"), bg="#2c3e50", fg="#e74c3c")
        self.lbl_error.pack(pady=10)

    def check_pin(self, event=None):
        entered_pin = self.entry_pin.get().strip()
        
        # 1. Check Master Key First
        if entered_pin == MASTER_KEY:
            self.unlock("Master Key Accepted! Unlocking...")
            
        # 2. Check the Rotating TOTP Pin
        elif self.totp.verify(entered_pin):
            self.unlock("Time-Based PIN Accepted! Unlocking...")
            
        # 3. Failed
        else:
            self.lbl_error.config(text="Invalid PIN. Please try again.")
            self.entry_pin.delete(0, tk.END)

    def unlock(self, message):
        # For the prototype, we just show a success message and close the app.
        messagebox.showinfo("Unlocked", message)
        self.root.destroy()

    def disable_event(self):
        # This function does nothing, which intentionally prevents the window from closing
        pass 

if __name__ == "__main__":
    root = tk.Tk()
    app = LockScreen(root)
    root.mainloop()
