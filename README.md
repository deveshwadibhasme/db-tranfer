# MongoDB Database Transfer Program

A robust, streaming Node.js data transfer program designed to migrate documents between MongoDB Atlas clusters with support for nested model directories.

## Features

- **Recursive Model Discovery**: Automatically discovers all Mongoose models in `models/` and any nested subdirectories (`models/appoinment/`, `models/childcare/`, `models/common/`, `models/lab/`, `models/master/`, `models/mothercare/`, `models/pharmacy/`, `models/user/`, etc.).
- **Flexible Model Exports**: Supports default exports, direct model exports, and named exports (e.g. `{ Testimonial, ... }`).
- **Natural / Alphabetical Ordering**: Priority function has been commented out; collections are processed in alphabetical order.
- **High-Performance Streaming**: Uses MongoDB cursors with configurable batch sizes (`BATCH_SIZE=500` default) and `bulkWrite` operations for fast and memory-efficient migration.
- **Data Integrity & Idempotency**:
  - Uses native BSON document streaming and `replaceOne` with `{ upsert: true }`.
  - Preserves exact `_id`, dates, ObjectIds, and timestamps.
  - Does not trigger Mongoose pre-save hooks (avoids re-hashing already hashed passwords).
  - Can be safely stopped and re-run without duplicate key errors.
- **Dry Run Support**: Test source counts and verify the migration sequence with `--dry-run` without touching the target database.

---

## Discovered Models (32 Models Across Nested Folders)

| # | Model | Collection | File Path |
|---|-------|------------|-----------|
| 1 | `Address` | `addresses` | `models/user/address.model.js` |
| 2 | `Admin` | `admins` | `models/admin.model.js` |
| 3 | `Appointment` | `appointments` | `models/appoinment/appoinment.model.js` |
| 4 | `AppointmentSlot` | `appointmentslots` | `models/appoinment/appoinment.slot.model.js` |
| 5 | `Article` | `articles` | `models/master/article.model.js` |
| 6 | `AuditLog` | `auditlogs` | `models/common/auditlog.model.js` |
| 7 | `ChildCareProgress` | `childcareprogresses` | `models/childcare/childcare.progress.model.js` |
| 8 | `ChildCareSubscription` | `childcaresubscriptions` | `models/childcare/childcare.sub.model.js` |
| 9 | `DietPlan` | `dietplans` | `models/master/diet.model.js` |
| 10 | `DoctorProfile` | `doctorprofiles` | `models/user/doctor.model.js` |
| 11 | `DoctorSchedule` | `doctorschedules` | `models/appoinment/schedule.model.js` |
| 12 | `EmergencyRequest` | `emergencyrequests` | `models/common/emergencyreq.model.js` |
| 13 | `ExercisePlan` | `exerciseplans` | `models/master/exercise.model.js` |
| 14 | `Hospital` | `hospitals` | `models/user/hospital.model.js` |
| 15 | `LabBooking` | `labbookings` | `models/lab/labbooking.model.js` |
| 16 | `LabReport` | `labreports` | `models/lab/labreport.model.js` |
| 17 | `LabTest` | `labtests` | `models/lab/labtest.model.js` |
| 18 | `MedicineOrder` | `medicineorders` | `models/pharmacy/medicine.model.js` |
| 19 | `MotherCareProgress` | `mothercareprogresses` | `models/mothercare/mothercare.progress.model.js` |
| 20 | `MotherCareSubscription` | `mothercaresubscriptions` | `models/mothercare/mothercare.sub.model.js` |
| 21 | `Notification` | `notifications` | `models/master/notification.model.js` |
| 22 | `OTP` | `otps` | `models/user/otp.model.js` |
| 23 | `PathologyLab` | `pathologylabs` | `models/user/pathology.model.js` |
| 24 | `Payment` | `payments` | `models/common/payment.model.js` |
| 25 | `Pharmacy` | `pharmacies` | `models/user/pharmacy.model.js` |
| 26 | `Prescription` | `prescriptions` | `models/appoinment/prescription.model.js` |
| 27 | `Review` | `reviews` | `models/master/review.model.js` |
| 28 | `Role` | `roles` | `models/user/role.model.js` |
| 29 | `SubscriptionPlan` | `subscriptionplans` | `models/master/subscription.model.js` |
| 30 | `Testimonial` | `testimonials` | `models/master/testonominal.mode.js` |
| 31 | `User` | `users` | `models/user/user.model.js` |
| 32 | `ZoomMeeting` | `zoommeetings` | `models/appoinment/zoom.model.js` |

---

## How to Run

### 1. Dry Run (Simulation)
Inspect source counts and execution order without writing to the target database:
```bash
node transfer.js --dry-run
```

### 2. Full Transfer (Default: Safe Upsert)
Transfer all collections from source to target:
```bash
node transfer.js
# or
npm start
```

### 3. Advanced CLI Options
- **Clean slate before transferring** (drops target collections first):
  ```bash
  node transfer.js --clean
  ```
- **Copy source indexes** to target collections:
  ```bash
  node transfer.js --copy-indexes
  ```
- **Custom batch size**:
  ```bash
  node transfer.js --batch-size 1000
  ```
- **Transfer a single collection/model**:
  ```bash
  node transfer.js --only User
  node transfer.js --only Appointment
  ```
