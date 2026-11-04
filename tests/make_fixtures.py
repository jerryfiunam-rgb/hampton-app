# Genera estados de cuenta SINTÉTICOS (solo para pruebas). No contienen datos reales.
import sys
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

def stmt(path, mes, anio, num, ini, fin, movs, dep, ret):
    c = canvas.Canvas(path, pagesize=letter)
    c.setFont("Helvetica-Bold", 12); c.drawString(50, 740, "BANCO DE PRUEBA S.A. - DOCUMENTO SINTETICO PARA PRUEBAS")
    c.setFont("Helvetica", 10)
    c.drawString(50, 722, "CONDOMINIO DE PRUEBA A.C.   CUENTA DE CHEQUES 000123456")
    c.drawString(50, 708, f"PERIODO DEL 01/{mes}/{anio} AL {num}/{mes}/{anio}")
    c.drawString(50, 690, "SALDO ANTERIOR"); c.drawRightString(560, 690, f"{ini:,.2f}")
    c.drawString(50, 676, "DEPOSITOS"); c.drawRightString(560, 676, f"{dep:,.2f}")
    c.drawString(50, 662, "RETIROS"); c.drawRightString(560, 662, f"{ret:,.2f}")
    c.drawString(50, 648, "SALDO FINAL"); c.drawRightString(560, 648, f"{fin:,.2f}")
    y = 620
    c.setFont("Helvetica-Bold", 9)
    for x, t in [(50, "FECHA"), (110, "CONCEPTO"), (400, "CARGOS"), (480, "ABONOS")]: c.drawString(x, y, t)
    c.setFont("Helvetica", 9); y -= 16
    for d, concept, cargo, abono in movs:
        c.drawString(50, y, d); c.drawString(110, y, concept)
        if cargo: c.drawRightString(460, y, f"{cargo:,.2f}")
        if abono: c.drawRightString(540, y, f"{abono:,.2f}")
        y -= 14
    c.save()

jan = [("05/ENE", "CUOTA MANTENIMIENTO DEPTO 101-140", 0, 120000), ("08/ENE", "SERV LIMPIEZA ENERO", 18000, 0), ("10/ENE", "VIGILANCIA SEGURIDAD PRIVADA", 45000, 0),
       ("12/ENE", "CFE LUZ AREAS COMUNES", 6200, 0), ("15/ENE", "HONORARIOS ADMINISTRACION", 15000, 0), ("20/ENE", "APORTACION IMPERMEAB EDIF 1", 0, 40000), ("28/ENE", "SERV JARDINERIA", 9800, 0)]
inc = sum(m[3] for m in jan); exp = sum(m[2] for m in jan)
stmt(sys.argv[1] + "/sintetico-2026-01.pdf", "ENE", 2026, 31, 500000, 500000 + inc - exp, jan, inc, exp)
feb = [("05/FEB", "CUOTA MANTENIMIENTO DEPTO 101-140", 0, 112000), ("08/FEB", "SERV LIMPIEZA FEBRERO", 18000, 0), ("10/FEB", "VIGILANCIA SEGURIDAD PRIVADA", 48000, 0),
       ("14/FEB", "SERV JARDINERIA", 20000, 0), ("14/FEB", "SERV JARDINERIA", 20000, 0), ("18/FEB", "IMPERMEAB EDIF 1 PARTE 2", 30000, 0), ("22/FEB", "SPEI 4471 PROV XYZ", 7500, 0)]
inc2 = sum(m[3] for m in feb); exp2 = sum(m[2] for m in feb)
ini2 = 500000 + inc - exp - 2000  # discontinuidad sintética de $2,000
stmt(sys.argv[1] + "/sintetico-2026-02.pdf", "FEB", 2026, 28, ini2, ini2 + inc2 - exp2 + 1000, feb, inc2, exp2)  # descuadre sintético de $1,000
print("ok", 500000 + inc - exp, ini2)
